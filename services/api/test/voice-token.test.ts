import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission, serializePermissions } from "@umaru/protocol";
import { createLiveKitToken, verifyLiveKitToken } from "../src/voice/livekit.js";
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
 * Token vào phòng âm thanh (LiveKit).
 *
 * Đây là chỗ **duy nhất** trong hệ thống phát ra thứ mở được luồng media, nên
 * test kiểm cả ba lớp: điều kiện cấp (đang ở trong phòng, có `CONNECT`), nội
 * dung token (ký đúng secret, đúng phòng, đúng hạn), và quyền nói (`SPEAK` →
 * `canPublish`).
 */

const API_KEY = "APIexamplekey";
const API_SECRET = "test-livekit-secret-khong-dung-that";

let ctx: TestContext;
let owner: RegisteredUser;
let member: RegisteredUser;
let outsider: RegisteredUser;
let guildId: string;
let voiceChannelId: string;
let textChannelId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    LIVEKIT_URL: "wss://umaru-test.livekit.cloud",
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
  });

  owner = await registerUser(ctx, "vt_owner");
  member = await registerUser(ctx, "vt_member");
  outsider = await registerUser(ctx, "vt_outsider");
  guildId = await createGuild(ctx, owner.token, "Voice token guild");
  textChannelId = (await listChannels(ctx, owner.token, guildId))[0]!.id;

  const created = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(owner.token),
    payload: { name: "Phòng có tiếng", type: "guild_voice" },
  });
  expect(created.statusCode).toBe(201);
  voiceChannelId = created.json<{ id: string }>().id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(owner.token),
    payload: { channelId: textChannelId },
  });
  const joined = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
    headers: auth(member.token),
  });
  expect(joined.statusCode).toBe(200);
});

afterAll(async () => {
  await ctx.close();
});

function join(user: RegisteredUser) {
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/channels/${voiceChannelId}/voice`,
    headers: auth(user.token),
  });
}

function token(user: RegisteredUser, channelId = voiceChannelId) {
  return ctx.app.inject({
    method: "GET",
    url: `/api/v1/channels/${channelId}/voice/token`,
    headers: auth(user.token),
  });
}

function denyFor(token_: string, userId: string, perm: bigint) {
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/channels/${voiceChannelId}/overwrites/member/${userId}`,
    headers: auth(token_),
    payload: { allow: "0", deny: serializePermissions(perm) },
  });
}

describe("GET /channels/:id/voice/token", () => {
  it("đang ở trong phòng → token hợp lệ, đúng phòng, đúng người, đúng hạn", async () => {
    expect((await join(owner)).statusCode).toBe(200);

    const response = await token(owner);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      url: string;
      token: string;
      room: string;
      identity: string;
      expiresAt: string;
      canPublish: boolean;
      canSubscribe: boolean;
    }>();

    expect(body.url).toBe("wss://umaru-test.livekit.cloud");
    expect(body.room).toBe(voiceChannelId);
    expect(body.identity).toBe(owner.id);
    expect(body.canPublish).toBe(true); // owner có ALL_PERMISSIONS
    expect(body.canSubscribe).toBe(true);

    // Chữ ký phải xác thực bằng secret của server — sai secret là SFU từ chối.
    const verified = verifyLiveKitToken(body.token, API_SECRET);
    expect(verified.valid).toBe(true);
    const payload = verified.payload as {
      iss: string;
      sub: string;
      exp: number;
      nbf: number;
      video: Record<string, unknown>;
    };
    expect(payload.iss).toBe(API_KEY);
    expect(payload.sub).toBe(owner.id);
    expect(payload.video).toMatchObject({
      room: voiceChannelId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // Hạn 1 giờ (mặc định) và không lệch quá vài giây.
    expect(Math.abs(payload.exp - Date.now() / 1000 - 3600)).toBeLessThan(10);
    // `nbf` lùi 10 giây để chịu được lệch giờ giữa API và SFU.
    expect(payload.nbf).toBeLessThan(Date.now() / 1000);

    // Sai secret thì phải là không hợp lệ (chống trường hợp "verify" luôn đúng).
    expect(verifyLiveKitToken(body.token, `${API_SECRET}x`).valid).toBe(false);
    // Token rác không làm ném lỗi.
    expect(verifyLiveKitToken("a.b", API_SECRET)).toEqual({ valid: false, payload: null });
  });

  it("chưa vào phòng → 404 (token là chìa khoá media, không phát trước)", async () => {
    const response = await token(member);
    expect(response.statusCode).toBe(404);
  });

  it("vào phòng rồi → member không có SPEAK vẫn nghe được (canPublish false)", async () => {
    expect((await join(member)).statusCode).toBe(200);
    expect((await denyFor(owner.token, member.id, Permission.SPEAK)).statusCode).toBe(200);
    await ctx.hub.refreshGuildVisibility(guildId);

    const response = await token(member);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ canPublish: boolean; canSubscribe: boolean }>();
    expect(body.canPublish).toBe(false);
    expect(body.canSubscribe).toBe(true);

    // Không có SPEAK nhưng vẫn ở trong phòng — không bị đá ra.
    const rows = await ctx.pool.query("SELECT 1 FROM voice_states WHERE user_id = $1", [member.id]);
    expect(rows.rowCount).toBe(1);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceChannelId}/overwrites/member/${member.id}`,
      headers: auth(owner.token),
    });
    await ctx.hub.refreshGuildVisibility(guildId);
  });

  it("thiếu CONNECT → 403 (không lấy được token dù đã ở trong phòng)", async () => {
    expect((await denyFor(owner.token, member.id, Permission.CONNECT)).statusCode).toBe(200);
    await ctx.hub.refreshGuildVisibility(guildId);
    // Chỉ mất CONNECT (vẫn xem được kênh) → vẫn ngồi trong phòng nhưng **không**
    // được cấp token mới. Không phải 404: người dùng cần biết là thiếu quyền,
    // không phải "phòng không tồn tại".
    const denied = await token(member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceChannelId}/overwrites/member/${member.id}`,
      headers: auth(owner.token),
    });
    await ctx.hub.refreshGuildVisibility(guildId);
  });

  it("người ngoài guild → 404, kênh chữ → 400", async () => {
    expect((await token(outsider)).statusCode).toBe(404);
    expect((await token(owner, textChannelId)).statusCode).toBe(400);
  });
});

describe("createLiveKitToken", () => {
  it("hạn token theo `ttlSec` và `now` bơm vào (test được mà không chờ)", () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const result = createLiveKitToken({
      config: { url: "wss://x.livekit.cloud", apiKey: API_KEY, apiSecret: API_SECRET },
      room: "123",
      identity: "456",
      displayName: "An",
      canPublish: false,
      canSubscribe: true,
      ttlSec: 120,
      now,
    });
    expect(result.expiresAt).toBe(new Date(now + 120_000).toISOString());
    const payload = verifyLiveKitToken(result.token, API_SECRET).payload as {
      exp: number;
      nbf: number;
      iat: number;
      video: { canPublish: boolean; canPublishData: boolean };
    };
    expect(payload.exp).toBe(Math.floor(now / 1000) + 120);
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect(payload.nbf).toBe(Math.floor(now / 1000) - 10);
    // Chat đi qua gateway, không qua data packet của SFU.
    expect(payload.video.canPublishData).toBe(false);
    expect(result.canPublish).toBe(false);
  });
});

describe("khi chưa cấu hình LiveKit", () => {
  it("vẫn join/leave được (chỉ là chưa có tiếng), xin token → 503 kèm lý do", async () => {
    const offline = await createTestContext();
    try {
      const user = await registerUser(offline, "vt_nolivekit");
      const guild = await createGuild(offline, user.token, "Không có SFU");
      const text = (await listChannels(offline, user.token, guild))[0]!.id;
      const created = await offline.app.inject({
        method: "POST",
        url: `/api/v1/guilds/${guild}/channels`,
        headers: auth(user.token),
        payload: { name: "Phòng câm", type: "guild_voice" },
      });
      const voice = created.json<{ id: string }>().id;

      const joined = await offline.app.inject({
        method: "PUT",
        url: `/api/v1/channels/${voice}/voice`,
        headers: auth(user.token),
      });
      expect(joined.statusCode).toBe(200);

      const response = await offline.app.inject({
        method: "GET",
        url: `/api/v1/channels/${voice}/voice/token`,
        headers: auth(user.token),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { message: string } }>().error.message).toContain("LIVEKIT");
      // Kênh chữ vẫn dùng bình thường.
      const textList = await offline.app.inject({
        method: "GET",
        url: `/api/v1/channels/${text}/messages`,
        headers: auth(user.token),
      });
      expect(textList.statusCode).toBe(200);
    } finally {
      await offline.close();
    }
  });
});
