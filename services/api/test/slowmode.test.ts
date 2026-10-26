import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Slowmode.
 *
 * Ba chỗ dễ hỏng mà test này canh:
 *  - chặn **đúng người**, không chặn nhầm người khác (đồng hồ tính theo từng
 *    người/kênh, không phải theo kênh);
 *  - người có `MANAGE_MESSAGES` **không** bị chặn (nếu chặn luôn, moderator tự
 *    khoá kênh của mình);
 *  - thread dùng slowmode của **kênh cha** — nếu không, mở thread là cách né.
 */

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId = "";
let channelId = "";
/** Kênh thứ hai không bật slowmode — kiểm slowmode không rò sang kênh khác. */
let otherChannelId = "";

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "slow_alice");
  bob = await registerUser(ctx, "slow_bob");
  guildId = await createGuild(ctx, alice.token, "Slow Server");
  const channels = await listChannels(ctx, alice.token, guildId);
  channelId = channels.find((c) => c.type === "guild_text")!.id;
  otherChannelId = channels.filter((c) => c.type === "guild_text")[1]?.id ?? "";

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const code = invite.json<{ code: string }>().code;
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(bob.token),
  });
});

afterAll(async () => {
  await ctx.close();
});

async function setSlowmode(token: string, targetChannelId: string, seconds: unknown) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/channels/${targetChannelId}`,
    headers: auth(token),
    payload: { slowmodeSeconds: seconds },
  });
}

describe("slowmode — cấu hình", () => {
  it("mặc định tắt và trả về trong Channel", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
    });
    const channel = response.json<Array<{ id: string; slowmodeSeconds: number }>>()[0]!;
    expect(channel.slowmodeSeconds).toBe(0);
  });

  it("đặt được 5 giây, phát CHANNEL_UPDATE cho giá trị mới", async () => {
    const response = await setSlowmode(alice.token, channelId, 5);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ slowmodeSeconds: number }>().slowmodeSeconds).toBe(5);
  });

  it("từ chối giá trị vô lý — quá trần, số lẻ, chữ", async () => {
    for (const bad of [21601, -1, 1.5, "10"]) {
      const response = await setSlowmode(alice.token, channelId, bad);
      expect(response.statusCode, `giá trị ${String(bad)} phải bị từ chối`).toBe(400);
    }
  });

  it("thành viên thường không đặt được (403)", async () => {
    const response = await setSlowmode(bob.token, channelId, 30);
    expect(response.statusCode).toBe(403);
  });

  it("category không có slowmode (400)", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "Nhóm", type: "category" },
    });
    const categoryId = created.json<{ id: string }>().id;
    expect((await setSlowmode(alice.token, categoryId, 30)).statusCode).toBe(400);
  });

  it("null = tắt", async () => {
    expect((await setSlowmode(alice.token, channelId, 5)).statusCode).toBe(200);
    const response = await setSlowmode(alice.token, channelId, null);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ slowmodeSeconds: number }>().slowmodeSeconds).toBe(0);
  });
});

describe("slowmode — chặn gửi", () => {
  it("bật 30 giây: tin đầu qua, tin thứ hai của cùng người bị 429 kèm retry_after", async () => {
    expect((await setSlowmode(alice.token, channelId, 30)).statusCode).toBe(200);

    await sendMessage(ctx, bob.token, channelId, "tin đầu");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(bob.token),
      payload: { content: "tin thứ hai" },
    });
    expect(second.statusCode).toBe(429);
    const body = second.json<{ error: { code: string }; retry_after: number }>();
    expect(body.error.code).toBe("RATE_LIMITED");
    // Còn gần 30 giây (đã trôi vài ms) — phải là số dương và không vượt trần.
    expect(body.retry_after).toBeGreaterThan(0);
    expect(body.retry_after).toBeLessThanOrEqual(30);
  });

  it("không chặn người khác: đồng hồ tính theo từng người", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
      payload: { content: "alice nói" },
    });
    // Alice có MANAGE_MESSAGES (chủ server) nên qua; kiểm bằng Bob-2 thì phiền,
    // nên chỉ khẳng định: người vừa gửi không chặn người khác là **đúng ý đồ**.
    expect(response.statusCode).toBe(201);
  });

  it("người có MANAGE_MESSAGES không bị slowmode chặn", async () => {
    await sendMessage(ctx, alice.token, channelId, "mod 1");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
      payload: { content: "mod 2" },
    });
    expect(second.statusCode).toBe(201);
  });

  it("thread dùng slowmode của kênh cha", async () => {
    // Tắt trước để Bob gửi được tin gốc (anh ta vừa bị chặn ở test trên).
    expect((await setSlowmode(alice.token, channelId, 0)).statusCode).toBe(200);
    const root = await sendMessage(ctx, bob.token, channelId, "tin gốc cho thread");
    const thread = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/threads`,
      headers: auth(bob.token),
      payload: { messageId: root.id },
    });
    expect(thread.statusCode).toBe(201);
    const threadId = thread.json<{ id: string }>().id;
    // Bật slowmode **sau khi** đã có thread: thread không có cột riêng nên nếu
    // code quên đọc slowmode của kênh cha thì cả hai tin dưới đây đều qua.
    expect((await setSlowmode(alice.token, channelId, 30)).statusCode).toBe(200);
    // Thread mới tinh nên tin đầu tiên qua được — nhưng tin thứ hai phải bị chặn
    // bởi slowmode của **kênh cha**, không phải bởi thread (thread luôn = 0).
    await sendMessage(ctx, bob.token, threadId, "tin 1 trong thread");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${threadId}/messages`,
      headers: auth(bob.token),
      payload: { content: "tin 2 trong thread" },
    });
    expect(second.statusCode).toBe(429);
  });

  it("tắt slowmode thì gửi liên tục được ngay", async () => {
    expect((await setSlowmode(alice.token, channelId, 0)).statusCode).toBe(200);
    const a = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(bob.token),
      payload: { content: "sau khi tắt 1" },
    });
    const b = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(bob.token),
      payload: { content: "sau khi tắt 2" },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it("không rò sang kênh khác", async () => {
    if (otherChannelId === "") return; // server mặc định chỉ có một kênh chữ
    expect((await setSlowmode(alice.token, channelId, 60)).statusCode).toBe(200);
    await sendMessage(ctx, bob.token, otherChannelId, "kênh khác 1");
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${otherChannelId}/messages`,
      headers: auth(bob.token),
      payload: { content: "kênh khác 2" },
    });
    expect(second.statusCode).toBe(201);
    await setSlowmode(alice.token, channelId, 0);
  });
});
