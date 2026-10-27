import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Hồ sơ công khai (mục 52): giới thiệu, đại từ, màu banner.
 *
 * Trọng tâm: `PATCH` chỉ ghi trường được gửi (không xoá trường khác), dữ liệu
 * bẩn bị chặn trước khi vào DB, và `GET` chỉ mở cho người **có liên hệ**.
 */

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let stranger: RegisteredUser;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "pf_alice");
  bob = await registerUser(ctx, "pf_bob");
  stranger = await registerUser(ctx, "pf_stranger");

  // Alice + Bob chung server; stranger không chung gì cả.
  const guildId = await createGuild(ctx, alice.token, "Profile GW");
  const channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const { code } = invite.json<{ code: string }>();
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(bob.token),
  });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

async function connect(user: RegisteredUser): Promise<GatewayTestClient> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: 2, d: { token: user.token } });
  await client.next((frame) => frame.op === 0 && frame.t === "READY");
  return client;
}

function patch(token: string, payload: unknown) {
  return ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/users/@me/profile",
    headers: auth(token),
    payload: payload as Record<string, unknown>,
  });
}

function getProfile(token: string, userId: string) {
  return ctx.app.inject({
    method: "GET",
    url: `/api/v1/users/${userId}/profile`,
    headers: auth(token),
  });
}

describe("PATCH /users/@me/profile", () => {
  it("lưu giới thiệu, đại từ và màu banner", async () => {
    const response = await patch(alice.token, {
      bio: "  Thích cà phê Đà Lạt  ",
      pronouns: "cô ấy",
      bannerColor: "#10B981",
    });
    expect(response.statusCode).toBe(200);
    const user = response.json<{ bio: string; pronouns: string; bannerColor: string }>();
    // Cắt khoảng trắng hai đầu, màu chuẩn hoá về chữ thường.
    expect(user.bio).toBe("Thích cà phê Đà Lạt");
    expect(user.pronouns).toBe("cô ấy");
    expect(user.bannerColor).toBe("#10b981");
  });

  it("chỉ gửi một trường thì hai trường kia giữ nguyên", async () => {
    await patch(alice.token, { bio: "giữ tôi", pronouns: "anh ấy", bannerColor: "#123456" });
    const response = await patch(alice.token, { bio: "chỉ đổi giới thiệu" });
    expect(response.statusCode).toBe(200);
    const user = response.json<{ bio: string; pronouns: string; bannerColor: string }>();
    expect(user.bio).toBe("chỉ đổi giới thiệu");
    expect(user.pronouns).toBe("anh ấy");
    expect(user.bannerColor).toBe("#123456");
  });

  it("gửi null hoặc chuỗi rỗng để xoá", async () => {
    await patch(alice.token, { bio: "xoá tôi", pronouns: "họ", bannerColor: "#abcdef" });
    const response = await patch(alice.token, { bio: null, pronouns: "   ", bannerColor: "" });
    expect(response.statusCode).toBe(200);
    const user = response.json<{
      bio: string | null;
      pronouns: string | null;
      bannerColor: string | null;
    }>();
    expect(user.bio).toBeNull();
    expect(user.pronouns).toBeNull();
    expect(user.bannerColor).toBeNull();
  });

  it("body rỗng trả hồ sơ hiện tại, không phải lỗi", async () => {
    await patch(alice.token, { bio: "vẫn còn" });
    const response = await patch(alice.token, {});
    expect(response.statusCode).toBe(200);
    expect(response.json<{ bio: string | null }>().bio).toBe("vẫn còn");
  });

  it("giới thiệu quá 190 ký tự bị từ chối", async () => {
    const response = await patch(alice.token, { bio: "a".repeat(191) });
    expect(response.statusCode).toBe(400);
    // 190 ký tự + khoảng trắng hai đầu vẫn hợp lệ (đo sau khi cắt).
    const ok = await patch(alice.token, { bio: `  ${"a".repeat(190)}  ` });
    expect(ok.statusCode).toBe(200);
  });

  it("đại từ quá 40 ký tự bị từ chối", async () => {
    const response = await patch(alice.token, { pronouns: "a".repeat(41) });
    expect(response.statusCode).toBe(400);
  });

  it("màu banner sai định dạng bị từ chối", async () => {
    for (const bad of ["red", "#12345", "#1234567", "url(x)", "#GGGGGG", "rgb(1,2,3)"]) {
      const response = await patch(alice.token, { bannerColor: bad });
      expect(response.statusCode, bad).toBe(400);
    }
  });

  it("sai kiểu dữ liệu bị từ chối", async () => {
    expect((await patch(alice.token, { bio: 42 })).statusCode).toBe(400);
    expect((await patch(alice.token, { pronouns: ["a"] })).statusCode).toBe(400);
    expect((await patch(alice.token, { bannerColor: 7 })).statusCode).toBe(400);
    // Mảng là body không hợp lệ dù phần tử đúng kiểu.
    expect((await patch(alice.token, [])).statusCode).toBe(400);
  });
});

describe("GET /users/:id/profile", () => {
  it("người khác xem được hồ sơ khi chung server", async () => {
    await patch(alice.token, {
      bio: "hồ sơ của alice",
      pronouns: "cô ấy",
      bannerColor: "#0ea5e9",
    });
    const response = await getProfile(bob.token, alice.id);
    expect(response.statusCode).toBe(200);
    const profile = response.json<{
      id: string;
      username: string;
      bio: string | null;
      pronouns: string | null;
      bannerColor: string | null;
      createdAt: string;
    }>();
    expect(profile.id).toBe(alice.id);
    expect(profile.username).toBe(alice.username);
    expect(profile.bio).toBe("hồ sơ của alice");
    expect(profile.pronouns).toBe("cô ấy");
    expect(profile.bannerColor).toBe("#0ea5e9");
    // Không rò email hay mật khẩu qua đường này.
    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("passwordHash");
    expect(typeof profile.createdAt).toBe("string");
  });

  it("tự xem hồ sơ của mình vẫn được", async () => {
    const response = await getProfile(alice.token, alice.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }>().id).toBe(alice.id);
  });

  it("không có liên hệ → 404 (không phải 403, để không xác nhận id có thật)", async () => {
    const response = await getProfile(stranger.token, alice.id);
    expect(response.statusCode).toBe(404);
  });

  it("id không tồn tại → 404", async () => {
    const response = await getProfile(alice.token, "999999999999999999");
    expect(response.statusCode).toBe(404);
  });

  it("chưa đăng nhập → 401", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/users/${alice.id}/profile`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("USER_UPDATE", () => {
  it("đổi hồ sơ phát USER_UPDATE kèm ba trường mới cho người chung server", async () => {
    const bobClient = await connect(bob);
    const response = await patch(alice.token, {
      bio: "phát qua gateway",
      pronouns: "anh ấy",
      bannerColor: "#f97316",
    });
    expect(response.statusCode).toBe(200);

    const frame = await bobClient.next(
      (candidate) => candidate.op === 0 && candidate.t === "USER_UPDATE",
    );
    const user = (frame.d as {
      user: { id: string; bio?: string; pronouns?: string; bannerColor?: string };
    }).user;
    expect(user.id).toBe(alice.id);
    expect(user.bio).toBe("phát qua gateway");
    expect(user.pronouns).toBe("anh ấy");
    expect(user.bannerColor).toBe("#f97316");
    // Presence là ephemeral: hồ sơ phát đi không được kèm "online" bịa.
    expect(user).not.toHaveProperty("status");
  });
});
