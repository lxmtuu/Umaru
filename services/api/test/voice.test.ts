import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission, serializePermissions } from "@umaru/protocol";
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
 * Kênh thoại G2 — lớp **state** (ai ở phòng nào, mute/deafen), chưa có âm thanh.
 * Trọng tâm là quyền: `CONNECT` để vào, `VIEW_CHANNEL` để thấy danh sách người,
 * và mất quyền xem thì bị đưa ra khỏi phòng.
 */

let ctx: TestContext;
let wsUrl: string;
let owner: RegisteredUser;
let member: RegisteredUser;
let outsider: RegisteredUser;
let guildId: string;
let voiceChannelId: string;
let textChannelId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  owner = await registerUser(ctx, "voice_owner");
  member = await registerUser(ctx, "voice_member");
  outsider = await registerUser(ctx, "voice_outsider");
  guildId = await createGuild(ctx, owner.token, "Voice guild");
  textChannelId = (await listChannels(ctx, owner.token, guildId))[0]!.id;

  const created = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(owner.token),
    payload: { name: "Phòng chung", type: "guild_voice" },
  });
  expect(created.statusCode).toBe(201);
  voiceChannelId = created.json<{ id: string }>().id;

  // member vào guild qua invite.
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

function join(user: RegisteredUser, channelId = voiceChannelId) {
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/channels/${channelId}/voice`,
    headers: auth(user.token),
  });
}

function leave(user: RegisteredUser, channelId = voiceChannelId) {
  return ctx.app.inject({
    method: "DELETE",
    url: `/api/v1/channels/${channelId}/voice`,
    headers: auth(user.token),
  });
}

describe("vào / rời phòng thoại", () => {
  it("join → 200 kèm trạng thái, READY có voiceStates, người khác nhận event", async () => {
    const ownerClient = await connect(owner);
    const memberClient = await connect(member);

    const response = await join(member);
    expect(response.statusCode).toBe(200);
    const state = response.json<{ channelId: string; userId: string; selfMute: boolean }>();
    expect(state.channelId).toBe(voiceChannelId);
    expect(state.userId).toBe(member.id);
    expect(state.selfMute).toBe(false);

    // Người đang xem kênh nhận VOICE_STATE_UPDATE.
    const event = await ownerClient.dispatch<{ channelId: string; userId: string }>(
      "VOICE_STATE_UPDATE",
    );
    expect(event.channelId).toBe(voiceChannelId);
    expect(event.userId).toBe(member.id);
    // Chính người join cũng nhận (để client khác thiết bị đồng bộ).
    const own = await memberClient.dispatch<{ channelId: string }>("VOICE_STATE_UPDATE");
    expect(own.channelId).toBe(voiceChannelId);
  });

  it("READY của người mới kết nối mang voiceStates của kênh họ xem được", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: 2, d: { token: owner.token } });
    const ready = await client.next((frame) => frame.op === 0 && frame.t === "READY");
    const states = (ready.d as { voiceStates: Array<{ userId: string; channelId: string }> })
      .voiceStates;
    expect(states.some((s) => s.userId === member.id && s.channelId === voiceChannelId)).toBe(true);
  });

  it("rời phòng → event channelId null, READY sau đó không còn trạng thái", async () => {
    const ownerClient = await connect(owner);
    const response = await leave(member);
    expect(response.statusCode).toBe(204);
    const event = await ownerClient.dispatch<{ channelId: string | null; userId: string }>(
      "VOICE_STATE_UPDATE",
    );
    expect(event.channelId).toBeNull();
    expect(event.userId).toBe(member.id);

    // Leave lần hai vẫn 204 (idempotent), không phát event rác.
    expect((await leave(member)).statusCode).toBe(204);
    await ownerClient.expectNoDispatch("VOICE_STATE_UPDATE");
  });

  it("mute/deafen: chỉ đổi của chính mình, phát event, không ở phòng → 404", async () => {
    const ownerClient = await connect(owner);
    await join(member);

    const muted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/voice-state`,
      headers: auth(member.token),
      payload: { selfMute: true },
    });
    expect(muted.statusCode).toBe(200);
    expect(muted.json<{ selfMute: boolean; selfDeaf: boolean }>()).toMatchObject({
      selfMute: true,
      selfDeaf: false,
    });
    await ownerClient.dispatch("VOICE_STATE_UPDATE");

    const deafened = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/voice-state`,
      headers: auth(member.token),
      payload: { selfDeaf: true },
    });
    expect(deafened.json<{ selfMute: boolean; selfDeaf: boolean }>()).toMatchObject({
      selfMute: true, // không bị reset khi chỉ đổi selfDeaf
      selfDeaf: true,
    });

    // Người không ở phòng nào → 404, không tạo trạng thái "mute trong hư không".
    const none = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/voice-state`,
      headers: auth(owner.token),
      payload: { selfMute: true },
    });
    expect(none.statusCode).toBe(404);

    // Body rỗng/sai kiểu → 400.
    const empty = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/voice-state`,
      headers: auth(member.token),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const badType = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/voice-state`,
      headers: auth(member.token),
      payload: { selfMute: "có" },
    });
    expect(badType.statusCode).toBe(400);
  });

  it("đổi kênh thoại thì tự rời kênh cũ (phát leave trước join)", async () => {
    const ownerClient = await connect(owner);
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(owner.token),
      payload: { name: "Phòng hai", type: "guild_voice" },
    });
    const secondId = second.json<{ id: string }>().id;

    const moved = await join(member, secondId);
    expect(moved.statusCode).toBe(200);
    const events = [
      await ownerClient.dispatch<{ channelId: string | null }>("VOICE_STATE_UPDATE"),
      await ownerClient.dispatch<{ channelId: string | null }>("VOICE_STATE_UPDATE"),
    ];
    expect(events[0]!.channelId).toBeNull(); // rời phòng cũ
    expect(events[1]!.channelId).toBe(secondId); // vào phòng mới

    // Chỉ một dòng trong DB: mỗi người một phòng mỗi server.
    const rows = await ctx.pool.query("SELECT 1 FROM voice_states WHERE user_id = $1", [member.id]);
    expect(rows.rowCount).toBe(1);
    await leave(member, secondId);
  });
});

describe("quyền trong kênh thoại", () => {
  it("thiếu CONNECT → 403 (kể cả khi xem được kênh)", async () => {
    // @everyone giữ VIEW_CHANNEL nhưng bỏ CONNECT.
    const everyone = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM roles WHERE guild_id = $1 AND is_everyone",
      [guildId],
    );
    await ctx.pool.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
      everyone.rows[0]!.id,
      serializePermissions(Permission.VIEW_CHANNEL),
    ]);
    await ctx.hub.refreshGuildVisibility(guildId);

    // Dùng `member` chứ không phải owner: chủ server luôn có CONNECT
    // (`resolvePermissions` trả ALL_PERMISSIONS cho owner) nên không hợp để thử.
    const denied = await join(member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

    // Trả quyền lại.
    await ctx.pool.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
      everyone.rows[0]!.id,
      serializePermissions(
        Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY | Permission.CONNECT,
      ),
    ]);
    await ctx.hub.refreshGuildVisibility(guildId);
    expect((await join(member)).statusCode).toBe(200);
    await leave(member);
  });

  it("người ngoài guild không thấy kênh → 404, không lộ sự tồn tại", async () => {
    const response = await join(outsider);
    expect(response.statusCode).toBe(404);
  });

  it("mất quyền XEM kênh thoại → bị đưa ra khỏi phòng và không nhận event nữa", async () => {
    const memberClient = await connect(member);
    await join(member);

    // Overwrite riêng cho member: deny VIEW_CHANNEL ở kênh thoại.
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${voiceChannelId}/overwrites/member/${member.id}`,
      headers: auth(owner.token),
      payload: { allow: "0", deny: serializePermissions(Permission.VIEW_CHANNEL) },
    });
    await ctx.hub.refreshGuildVisibility(guildId);

    // Bỏ qua event JOIN của chính mình (đã nhận ở trên), đợi đúng event rời phòng.
    const removed = await memberClient.next(
      (frame) =>
        frame.t === "VOICE_STATE_UPDATE" &&
        (frame.d as { channelId: string | null }).channelId === null,
    );
    const removedData = removed.d as { channelId: string | null; userId: string };
    expect(removedData.channelId).toBeNull();
    expect(removedData.userId).toBe(member.id);

    const rows = await ctx.pool.query("SELECT 1 FROM voice_states WHERE user_id = $1", [member.id]);
    expect(rows.rowCount).toBe(0);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voiceChannelId}/overwrites/member/${member.id}`,
      headers: auth(owner.token),
    });
    await ctx.hub.refreshGuildVisibility(guildId);
  });

  it("kênh chữ không phải kênh thoại → 400", async () => {
    const response = await join(owner, textChannelId);
    expect(response.statusCode).toBe(400);
  });

  it("hết session gateway (đóng app, quá TTL) → tự ra khỏi phòng thoại", async () => {
    const solo = await registerUser(ctx, "voice_solo");
    // Cho vào guild rồi vào phòng.
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(owner.token),
      payload: { channelId: textChannelId },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
      headers: auth(solo.token),
    });
    expect((await join(solo)).statusCode).toBe(200);

    const client = await connect(solo);
    client.close(); // mất kết nối → session chỉ bị xoá sau `sessionTtlMs`

    // Test context đặt SESSION_TTL_MS=5000 → chờ qua mốc đó.
    const deadline = Date.now() + 12_000;
    let remaining = 1;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // eslint-disable-next-line no-await-in-loop
      const rows = await ctx.pool.query("SELECT 1 FROM voice_states WHERE user_id = $1", [
        solo.id,
      ]);
      remaining = rows.rowCount ?? 0;
      if (remaining === 0) break;
    }
    expect(remaining).toBe(0);
  });

  it("quá nhiều thao tác join/leave liên tiếp → 429 kèm retry_after", async () => {
    // Context riêng vì nó TRUNCATE database dùng chung → để cuối file.
    const tight = await createTestContext({ RATE_LIMIT_VOICE_MUTATIONS: "2" });
    const user = await registerUser(tight, "voice_spam");
    const gid = await createGuild(tight, user.token, "Spam voice");
    const cid = (await listChannels(tight, user.token, gid))[0]!.id;
    const voice = await tight.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${gid}/channels`,
      headers: auth(user.token),
      payload: { name: "Phòng", type: "guild_voice" },
    });
    const vid = voice.json<{ id: string }>().id;

    const put = () =>
      tight.app.inject({
        method: "PUT",
        url: `/api/v1/channels/${vid}/voice`,
        headers: auth(user.token),
      });
    expect((await put()).statusCode).toBe(200);
    expect((await put()).statusCode).toBe(200);
    const blocked = await put();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ retry_after: number; error: { code: string } }>()).toMatchObject({
      retry_after: expect.any(Number),
      error: { code: "RATE_LIMITED" },
    });
    expect(cid.length).toBeGreaterThan(0);

    await tight.close();
  });
});
