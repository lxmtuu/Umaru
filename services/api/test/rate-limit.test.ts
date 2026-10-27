import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bucket, BucketStore, rateLimitedBody } from "../src/rateLimit.js";
import {
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Rate limit REST (spec §7): 5 tin/5s/người/kênh và 30 tin/phút/kênh.
 *
 * Test dùng giới hạn rất thấp để kiểm hành vi chặn; phần token bucket kiểm riêng
 * bằng đồng hồ giả nên không phải `sleep`.
 */

describe("token bucket", () => {
  it("cho đúng `limit` lần rồi chặn, và trả số giây phải chờ", () => {
    let now = 0;
    const bucket = new Bucket(3, 5_000, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([null, null, null]);
    // Hết token: 1 token = 5000/3 ms ≈ 1.67s → làm tròn lên 2s.
    expect(bucket.take()).toBe(2);

    now += 1_000;
    expect(bucket.take()).toBe(1); // đã hồi được 0.6 token
    now += 2_000;
    expect(bucket.take()).toBeNull();
  });

  it("nạp lại đầy sau một cửa sổ và không vượt trần", () => {
    let now = 0;
    const bucket = new Bucket(2, 1_000, () => now);
    bucket.take();
    bucket.take();
    expect(bucket.take()).toBe(1);
    now += 1_000;
    // Đầy lại nhưng vẫn chỉ 2 lần.
    expect(bucket.take()).toBeNull();
    expect(bucket.take()).toBeNull();
    expect(bucket.take()).toBe(1);
    now += 10_000; // chờ rất lâu cũng không dồn quá trần
    expect(bucket.take()).toBeNull();
    expect(bucket.take()).toBeNull();
    expect(bucket.take()).toBe(1);
  });

  it("BucketStore tách khoá và dọn khoá cũ khi vượt trần", () => {
    let now = 0;
    const store = new BucketStore(1, 1_000, 4, () => now);
    expect(store.take("a")).toBeNull();
    expect(store.take("a")).toBe(1);
    expect(store.take("b")).toBeNull(); // khoá khác không bị ảnh hưởng

    for (let index = 0; index < 20; index += 1) store.take(`key-${index}`);
    // Có dọn bớt chứ không phình vô hạn.
    expect(store.size).toBeLessThanOrEqual(5);
    // Khoá cũ đã bị đẩy ra → tạo lại là đầy token.
    expect(store.take("a")).toBeNull();
  });

  it("body 429 thống nhất có retry_after", () => {
    expect(rateLimitedBody(3, "chậm thôi")).toEqual({
      error: { code: "RATE_LIMITED", message: "chậm thôi" },
      retry_after: 3,
    });
  });
});

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    RATE_LIMIT_MESSAGES_PER_USER: "3",
    RATE_LIMIT_MESSAGES_PER_CHANNEL: "100",
  });
  alice = await registerUser(ctx, "rl_alice");
  bob = await registerUser(ctx, "rl_bob");
  guildId = await createGuild(ctx, alice.token, "Rate limit");
  channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
    headers: auth(bob.token),
  });
});

afterAll(async () => {
  await ctx.close();
});

async function send(token: string, content: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(token),
    payload: { content },
  });
  return {
    statusCode: response.statusCode,
    body: response.json<{ id?: string; retry_after?: number; error?: { code: string } }>(),
  };
}

describe("rate limit gửi tin (REST)", () => {
  it("quá 3 tin/5s vào cùng kênh → 429 kèm retry_after, không tạo tin", async () => {
    for (let index = 0; index < 3; index += 1) {
      expect((await send(alice.token, `tin ${index}`)).statusCode).toBe(201);
    }
    const blocked = await send(alice.token, "tin thứ tư");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error?.code).toBe("RATE_LIMITED");
    expect(blocked.body.retry_after).toBeGreaterThanOrEqual(1);
    expect(blocked.body.id).toBeUndefined();

    // Bị chặn thì tin không được ghi → lịch sử vẫn đúng 3 tin.
    const history = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    expect(history.json<unknown[]>()).toHaveLength(3);
  });

  it("giới hạn tính theo từng người: người khác gửi được ngay", async () => {
    const other = await send(bob.token, "bob gửi");
    expect(other.statusCode).toBe(201);
  });

  it("typing quá nhanh cũng 429 với cùng định dạng body", async () => {
    const url = `/api/v1/channels/${channelId}/typing`;
    const first = await ctx.app.inject({ method: "POST", url, headers: auth(bob.token) });
    expect(first.statusCode).toBe(204);
    const second = await ctx.app.inject({ method: "POST", url, headers: auth(bob.token) });
    expect(second.statusCode).toBe(429);
    const body = second.json<{ retry_after: number; error: { code: string } }>();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.retry_after).toBeGreaterThanOrEqual(1);
  });
});

describe("rate limit theo kênh (nhiều người spam)", () => {
  it("trần kênh chặn cả khi từng người vẫn còn lượt", async () => {
    const tight = await createTestContext({
      RATE_LIMIT_MESSAGES_PER_USER: "1000",
      RATE_LIMIT_MESSAGES_PER_CHANNEL: "3",
    });
    const owner = await registerUser(tight, "ch_owner");
    const spammer = await registerUser(tight, "ch_spammer");
    const gid = await createGuild(tight, owner.token, "Kênh hẹp");
    const cid = (await listChannels(tight, owner.token, gid))[0]!.id;
    const invite = await tight.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${gid}/invites`,
      headers: auth(owner.token),
      payload: { channelId: cid },
    });
    await tight.app.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
      headers: auth(spammer.token),
    });

    const post = (token: string, content: string) =>
      tight.app.inject({
        method: "POST",
        url: `/api/v1/channels/${cid}/messages`,
        headers: auth(token),
        payload: { content },
      });

    expect((await post(owner.token, "1")).statusCode).toBe(201);
    expect((await post(spammer.token, "2")).statusCode).toBe(201);
    expect((await post(owner.token, "3")).statusCode).toBe(201);
    // Người thứ tư (dù mỗi người mới gửi 1–2 tin) bị chặn vì cả kênh đã đủ.
    const blocked = await post(spammer.token, "4");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ retry_after: number }>().retry_after).toBeGreaterThanOrEqual(1);

    await tight.close();
  });
});

describe("chống dò mật khẩu ở /auth/login", () => {
  let ctx: TestContext;
  let victim: RegisteredUser;

  beforeAll(async () => {
    // Cửa sổ 15 phút nên trong một lần chạy test không thể chờ nguội; đặt trần
    // thấp để kiểm hành vi chặn. Trần theo email = 3, theo IP = 50 để test được
    // riêng từng bộ đếm.
    ctx = await createTestContext({
      RATE_LIMIT_AUTH_PER_IP: "50",
      RATE_LIMIT_AUTH_PER_EMAIL: "3",
    });
    victim = await registerUser(ctx, "brute_target");
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function login(email: string, password: string): Promise<number> {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    return response.statusCode;
  }

  it("sai mật khẩu vài lần → 401, quá trần thì 429 kèm retry_after", async () => {
    expect(await login("brute_target@example.com", "sai-1")).toBe(401);
    expect(await login("brute_target@example.com", "sai-2")).toBe(401);
    expect(await login("brute_target@example.com", "sai-3")).toBe(401);

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "brute_target@example.com", password: "sai-4" },
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{ error: { code: string }; retry_after: number }>();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.retry_after).toBeGreaterThan(0);
  });

  it("đang bị chặn thì mật khẩu ĐÚNG cũng không vào được (nếu không, giới hạn vô nghĩa)", async () => {
    expect(await login("brute_target@example.com", "mat-khau-123")).toBe(429);
  });

  it("trần theo email không ảnh hưởng tài khoản khác (không chặn oan cả server)", async () => {
    const other = await registerUser(ctx, "brute_bystander");
    expect(await login(`${other.username}@example.com`, "mat-khau-123")).toBe(200);
  });

  it("trần theo IP chặn được kẻ đổi email liên tục khi cùng một IP", async () => {
    const ipCtx = await createTestContext({
      RATE_LIMIT_AUTH_PER_IP: "2",
      RATE_LIMIT_AUTH_PER_EMAIL: "100",
    });
    try {
      const user = await registerUser(ipCtx, "ip_target");
      const attempt = async (email: string): Promise<number> =>
        (
          await ipCtx.app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email, password: "sai" },
          })
        ).statusCode;
      expect(await attempt(`${user.username}@example.com`)).toBe(401);
      expect(await attempt("khong-ton-tai@example.com")).toBe(401);
      // Đổi email mỗi lần vẫn bị chặn vì bộ đếm theo IP đã cạn.
      expect(await attempt("email-thu-ba@example.com")).toBe(429);
    } finally {
      await ipCtx.close();
    }
  });
});
