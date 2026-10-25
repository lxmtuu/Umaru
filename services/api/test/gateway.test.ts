import type { AddressInfo } from "node:net";
import {
  GatewayOpcode,
  Permission,
  createSnowflake,
  hasPermission,
  parsePermissions,
  serializePermissions,
} from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let generalId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  guildId = await createGuild(ctx, alice.token);
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId: generalId },
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

interface ReadyBody {
  user: { username: string };
  sessionId: string;
  guilds: Array<{
    guild: { id: string };
    channels: Array<{ id: string }>;
    roles: Array<{ id: string; name: string; position: number; isEveryone: boolean }>;
    members: Array<{ userId: string; roleIds: string[] }>;
  }>;
  channelPermissions: Record<string, string>;
}

/** Đợi PERMISSIONS_UPDATE có map thỏa điều kiện (frame khác vẫn nằm chờ trong queue). */
async function waitForPermsUpdate(
  client: GatewayTestClient,
  predicate: (channelPermissions: Record<string, string>) => boolean,
): Promise<Record<string, string>> {
  const frame = await client.next(
    (f) =>
      f.op === 0 &&
      f.t === "PERMISSIONS_UPDATE" &&
      predicate((f.d as { channelPermissions: Record<string, string> }).channelPermissions),
  );
  return (frame.d as { channelPermissions: Record<string, string> }).channelPermissions;
}

async function connectAndIdentify(user: RegisteredUser): Promise<{
  client: GatewayTestClient;
  sessionId: string;
  ready: ReadyBody;
}> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: GatewayOpcode.Identify, d: { token: user.token } });
  const ready = await client.dispatch<ReadyBody>("READY");
  return { client, sessionId: ready.sessionId, ready };
}

describe("gateway", () => {
  it("GET /gateway trả URL websocket", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/gateway",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ url: string; version: number }>();
    expect(body.version).toBe(1);
    expect(body.url).toContain("/api/v1/gateway/ws");
  });

  it("HELLO → IDENTIFY → READY kèm guild/channel; tin nhắn REST phát realtime", async () => {
    const { client, ready, sessionId } = await connectAndIdentify(alice);
    expect(sessionId.length).toBeGreaterThan(10);
    expect(ready.user.username).toBe("alice");
    expect(ready.guilds[0]?.channels.map((channel) => channel.id)).toContain(generalId);

    const message = await sendMessage(ctx, alice.token, generalId, "xin chào realtime");
    const created = await client.dispatch<{ id: string; content: string; channelId: string }>(
      "MESSAGE_CREATE",
    );
    expect(created).toMatchObject({ id: message.id, content: "xin chào realtime", channelId: generalId });

    // heartbeat được ack
    client.send({ op: GatewayOpcode.Heartbeat, d: client.lastSeq });
    const ack = await client.next((frame) => frame.op === GatewayOpcode.HeartbeatAck);
    expect(ack.op).toBe(11);
  });

  it("READY kèm channelPermissions riêng cho từng user", async () => {
    const owner = await connectAndIdentify(alice);
    const member = await connectAndIdentify(bob);

    const visibleIds = owner.ready.guilds.flatMap((snapshot) =>
      snapshot.channels.map((channel) => channel.id),
    );
    for (const id of visibleIds) {
      expect(owner.ready.channelPermissions[id]).toBeDefined();
    }

    const ownerBits = parsePermissions(owner.ready.channelPermissions[generalId] ?? "0");
    const memberBits = parsePermissions(member.ready.channelPermissions[generalId] ?? "0");
    expect(hasPermission(ownerBits, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(hasPermission(memberBits, Permission.MANAGE_MESSAGES)).toBe(false);
    expect(hasPermission(memberBits, Permission.SEND_MESSAGES)).toBe(true);

    // Kênh ẩn với @everyone: không thấy kênh thì cũng không có mục quyền nào.
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "chỉ owner" },
    });
    const hiddenId = created.json<{ id: string }>().id;
    await ctx.pool.query(
      `INSERT INTO permission_overwrites (channel_id, target_type, target_id, allow, deny)
       SELECT $1, 'role', r.id, '0', $2 FROM roles r WHERE r.guild_id = $3 AND r.is_everyone`,
      [hiddenId, serializePermissions(Permission.VIEW_CHANNEL), guildId],
    );

    const memberAgain = await connectAndIdentify(bob);
    expect(memberAgain.ready.channelPermissions[hiddenId]).toBeUndefined();
    expect(memberAgain.ready.guilds[0]?.channels.map((channel) => channel.id)).not.toContain(
      hiddenId,
    );
    // Owner (ALL_PERMISSIONS) vẫn thấy kênh đó và có quyền quản lý tin.
    const ownerAgain = await connectAndIdentify(alice);
    const hiddenOwnerBits = parsePermissions(ownerAgain.ready.channelPermissions[hiddenId] ?? "0");
    expect(hasPermission(hiddenOwnerBits, Permission.MANAGE_MESSAGES)).toBe(true);

    // DM: gửi được nhưng không ai có MANAGE_MESSAGES trên tin của người kia.
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(bob.token),
      payload: { recipientId: alice.id },
    });
    const dmId = dm.json<{ channel: { id: string } }>().channel.id;
    const bobDm = await connectAndIdentify(bob);
    const dmBits = parsePermissions(bobDm.ready.channelPermissions[dmId] ?? "0");
    expect(hasPermission(dmBits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(dmBits, Permission.MANAGE_MESSAGES)).toBe(false);
  });

  it("quyền đổi lúc đang kết nối → PERMISSIONS_UPDATE, không cần reconnect", async () => {
    const { client: aliceClient } = await connectAndIdentify(alice);
    const { client: bobClient } = await connectAndIdentify(bob);

    // 1) Kênh mới: session đã READY từ trước vẫn nhận quyền của kênh đó.
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "live-perms" },
    });
    const liveId = created.json<{ id: string }>().id;

    const bobUpdate = await bobClient.dispatch<{ channelPermissions: Record<string, string> }>(
      "PERMISSIONS_UPDATE",
    );
    const bobBits = parsePermissions(bobUpdate.channelPermissions[liveId] ?? "0");
    expect(hasPermission(bobBits, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(bobBits, Permission.MANAGE_MESSAGES)).toBe(false);

    const aliceUpdate = await aliceClient.dispatch<{ channelPermissions: Record<string, string> }>(
      "PERMISSIONS_UPDATE",
    );
    const aliceBits = parsePermissions(aliceUpdate.channelPermissions[liveId] ?? "0");
    expect(hasPermission(aliceBits, Permission.MANAGE_MESSAGES)).toBe(true);

    // 2) Gán role có MANAGE_MESSAGES lúc đang online → đẩy lại quyền ngay.
    const moderatorRoleId = createSnowflake(1023);
    await ctx.pool.query(
      `INSERT INTO roles (id, guild_id, name, position, permissions, is_everyone)
       VALUES ($1, $2, 'Mod', 5, $3, false)`,
      [
        moderatorRoleId,
        guildId,
        serializePermissions(
          Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_MESSAGES,
        ),
      ],
    );
    await ctx.pool.query(
      "INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)",
      [guildId, bob.id, moderatorRoleId],
    );
    await ctx.hub.refreshGuildVisibility(guildId);

    const promoted = await bobClient.dispatch<{ channelPermissions: Record<string, string> }>(
      "PERMISSIONS_UPDATE",
    );
    const promotedBits = parsePermissions(promoted.channelPermissions[generalId] ?? "0");
    expect(hasPermission(promotedBits, Permission.MANAGE_MESSAGES)).toBe(true);
  });

  it("không echo typing về chính người gõ", async () => {
    const { client: aliceClient } = await connectAndIdentify(alice);
    const { client: bobClient } = await connectAndIdentify(bob);

    const typing = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/typing`,
      headers: auth(bob.token),
    });
    expect(typing.statusCode).toBe(204);

    const received = await aliceClient.dispatch<{ userId: string; channelId: string }>("TYPING_START");
    expect(received).toMatchObject({ userId: bob.id, channelId: generalId });
    await bobClient.expectNoDispatch("TYPING_START", 300);
  });

  it("presence online được phát cho thành viên chung", async () => {
    const { client: aliceClient } = await connectAndIdentify(alice);
    const { client: bobClient } = await connectAndIdentify(bob);
    const update = await aliceClient.next((frame) => {
      if (frame.op !== 0 || frame.t !== "PRESENCE_UPDATE") return false;
      const data = frame.d as { userId: string; status: string };
      return data.userId === bob.id && data.status === "online";
    });
    expect((update.d as { status: string }).status).toBe("online");
    bobClient.close();
  });

  it("resume phát lại tin nhắn bị lỡ sau khi mất kết nối", async () => {
    const { client: first, sessionId } = await connectAndIdentify(alice);
    await sendMessage(ctx, bob.token, generalId, "trước khi rớt mạng");
    await first.dispatch("MESSAGE_CREATE");
    const seqBeforeDrop = first.lastSeq;
    first.close();
    await first.waitClose();

    // Mất kết nối, một tin nhắn mới được gửi trong lúc offline.
    const missed = await sendMessage(ctx, bob.token, generalId, "gửi trong lúc offline");

    const { client: second } = await GatewayTestClient.connect(wsUrl);
    clients.push(second);
    second.send({
      op: GatewayOpcode.Resume,
      d: { token: alice.token, sessionId, seq: seqBeforeDrop },
    });
    const replayed = await second.dispatch<{ id: string; content: string }>("MESSAGE_CREATE");
    expect(replayed.id).toBe(missed.id);
    expect(replayed.content).toBe("gửi trong lúc offline");
    const resumed = await second.next((frame) => frame.op === 0 && frame.t === "RESUMED");
    expect(resumed.s).toBeGreaterThan(seqBeforeDrop);
    await second.expectNoDispatch("READY", 300);
  });

  it("session không tồn tại → INVALID_SESSION false rồi identify lại được", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({
      op: GatewayOpcode.Resume,
      d: { token: alice.token, sessionId: "session-khong-ton-tai", seq: 1 },
    });
    const invalid = await client.next((frame) => frame.op === GatewayOpcode.InvalidSession);
    expect(invalid.d).toBe(false);

    client.send({ op: GatewayOpcode.Identify, d: { token: alice.token } });
    const ready = await client.dispatch<{ sessionId: string }>("READY");
    expect(ready.sessionId.length).toBeGreaterThan(10);
  });

  it("token sai bị đóng với close code 4000", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: GatewayOpcode.Identify, d: { token: "token-gia" } });
    expect(await client.waitClose()).toBe(4000);
  });

  it("mất VIEW_CHANNEL: nhận CHANNEL_DELETE và không thấy tin nhắn trong kênh", async () => {
    const { client: aliceClient } = await connectAndIdentify(alice);
    const { client: bobClient } = await connectAndIdentify(bob);

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "kín" },
    });
    const privateId = created.json<{ id: string }>().id;
    const channelCreated = await bobClient.dispatch<{ id: string }>("CHANNEL_CREATE");
    expect(channelCreated.id).toBe(privateId);
    // Đợi refresh quyền của route tạo kênh chạy xong trước khi đổi overwrite.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await ctx.pool.query(
      `INSERT INTO permission_overwrites (channel_id, target_type, target_id, allow, deny)
       SELECT $1, 'role', r.id, '0', $2 FROM roles r WHERE r.guild_id = $3 AND r.is_everyone`,
      [privateId, serializePermissions(Permission.VIEW_CHANNEL), guildId],
    );
    await ctx.hub.refreshGuildVisibility(guildId);

    const removed = await bobClient.dispatch<{ id: string }>("CHANNEL_DELETE");
    expect(removed.id).toBe(privateId);

    const message = await sendMessage(ctx, alice.token, privateId, "chỉ owner thấy");
    await aliceClient.next((frame) => {
      if (frame.op !== 0 || frame.t !== "MESSAGE_CREATE") return false;
      return (frame.d as { id: string }).id === message.id;
    });
    await bobClient.expectNoDispatch("MESSAGE_CREATE", 400);
  });

  it("thao tác role qua API → ROLE_* và PERMISSIONS_UPDATE realtime cho session đang mở", async () => {
    // Server riêng để test này không đụng dữ liệu của các test khác trong file.
    const liveGuildId = await createGuild(ctx, alice.token, "Roles live");
    const liveGeneralId = (await listChannels(ctx, alice.token, liveGuildId))[0]!.id;
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${liveGuildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: liveGeneralId },
    });
    const { code } = invite.json<{ code: string }>();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });

    const { client: aliceClient } = await connectAndIdentify(alice);
    const { client: bobClient } = await connectAndIdentify(bob);

    // 1) Tạo role → cả hai session trong server nhận ROLE_CREATE.
    const liveMod = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${liveGuildId}/roles`,
      headers: auth(alice.token),
      payload: {
        name: "LiveMod",
        permissions: serializePermissions(
          Permission.VIEW_CHANNEL |
            Permission.SEND_MESSAGES |
            Permission.READ_HISTORY |
            Permission.MANAGE_MESSAGES,
        ),
      },
    });
    expect(liveMod.statusCode).toBe(201);
    const liveModId = liveMod.json<{ id: string }>().id;

    const aliceSawCreate = await aliceClient.dispatch<{ guildId: string; role: { name: string } }>(
      "ROLE_CREATE",
    );
    expect(aliceSawCreate.guildId).toBe(liveGuildId);
    expect(aliceSawCreate.role.name).toBe("LiveMod");
    const bobSawCreate = await bobClient.dispatch<{ guildId: string; role: { id: string } }>(
      "ROLE_CREATE",
    );
    expect(bobSawCreate.role.id).toBe(liveModId);

    // 2) Gán role cho bob → PERMISSIONS_UPDATE của chính bob bật MANAGE_MESSAGES.
    const assign = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${liveGuildId}/members/${bob.id}/roles/${liveModId}`,
      headers: auth(alice.token),
    });
    expect(assign.statusCode).toBe(204);

    const afterAssign = await waitForPermsUpdate(bobClient, (perms) =>
      hasPermission(parsePermissions(perms[liveGeneralId] ?? "0"), Permission.MANAGE_MESSAGES),
    );
    expect(
      hasPermission(parsePermissions(afterAssign[liveGeneralId] ?? "0"), Permission.VIEW_CHANNEL),
    ).toBe(true);

    // 3) Sửa @everyone → mọi thành viên (kể cả người không mang role nào) nhận lại quyền.
    const roles = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${liveGuildId}/roles`,
      headers: auth(alice.token),
    });
    const everyoneId = roles
      .json<Array<{ id: string; isEveryone: boolean }>>()
      .find((role) => role.isEveryone)!.id;
    const everyoneEdit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${liveGuildId}/roles/${everyoneId}`,
      headers: auth(alice.token),
      payload: {
        permissions: serializePermissions(
          Permission.VIEW_CHANNEL |
            Permission.SEND_MESSAGES |
            Permission.READ_HISTORY |
            Permission.MENTION_EVERYONE,
        ),
      },
    });
    expect(everyoneEdit.statusCode).toBe(200);

    const afterEveryone = await waitForPermsUpdate(bobClient, (perms) =>
      hasPermission(parsePermissions(perms[liveGeneralId] ?? "0"), Permission.MENTION_EVERYONE),
    );
    // Vẫn giữ MANAGE_MESSAGES từ LiveMod — vì đây là map đầy đủ, không phải diff.
    expect(
      hasPermission(
        parsePermissions(afterEveryone[liveGeneralId] ?? "0"),
        Permission.MANAGE_MESSAGES,
      ),
    ).toBe(true);

    // 4) Xoá role (cascade member_roles) → quyền của bob mất ngay.
    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${liveGuildId}/roles/${liveModId}`,
      headers: auth(alice.token),
    });
    expect(deleted.statusCode).toBe(204);

    const bobSawDelete = await bobClient.dispatch<{ guildId: string; roleId: string }>(
      "ROLE_DELETE",
    );
    expect(bobSawDelete.roleId).toBe(liveModId);

    const afterDelete = await waitForPermsUpdate(
      bobClient,
      (perms) =>
        !hasPermission(
          parsePermissions(perms[liveGeneralId] ?? "0"),
          Permission.MANAGE_MESSAGES,
        ) &&
        hasPermission(parsePermissions(perms[liveGeneralId] ?? "0"), Permission.MENTION_EVERYONE),
    );
    expect(hasPermission(parsePermissions(afterDelete[liveGeneralId] ?? "0"), Permission.SEND_MESSAGES)).toBe(true);
  });

  it("READY kèm role của server + roleIds thành viên; gán/thu role phát GUILD_MEMBER_UPDATE", async () => {
    const rolesGuildId = await createGuild(ctx, alice.token, "Role snapshot");
    const rolesGeneralId = (await listChannels(ctx, alice.token, rolesGuildId))[0]!.id;
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${rolesGuildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: rolesGeneralId },
    });
    const { code } = invite.json<{ code: string }>();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${rolesGuildId}/roles`,
      headers: auth(alice.token),
      payload: { name: "Helper" },
    });
    expect(created.statusCode).toBe(201);
    const helperId = created.json<{ id: string }>().id;
    // Gán trước khi connect: READY phải kèm role ngay trong member summary.
    const assign = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${rolesGuildId}/members/${bob.id}/roles/${helperId}`,
      headers: auth(alice.token),
    });
    expect(assign.statusCode).toBe(204);

    const { client: aliceClient, ready: aliceReady } = await connectAndIdentify(alice);
    const { client: bobClient, ready: bobReady } = await connectAndIdentify(bob);

    const aliceSnapshot = aliceReady.guilds.find((g) => g.guild.id === rolesGuildId)!;
    // Mạnh nhất trước → Helper (position 1) đứng trên @everyone (0).
    expect(aliceSnapshot.roles.map((role) => role.name)).toEqual(["Helper", "@everyone"]);
    expect(aliceSnapshot.members.find((m) => m.userId === bob.id)!.roleIds).toEqual([helperId]);
    const bobSnapshot = bobReady.guilds.find((g) => g.guild.id === rolesGuildId)!;
    expect(bobSnapshot.members.find((m) => m.userId === bob.id)!.roleIds).toEqual([helperId]);

    // Thu role → mọi session trong server nhận summary mới (không phải tự ghép diff).
    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${rolesGuildId}/members/${bob.id}/roles/${helperId}`,
      headers: auth(alice.token),
    });
    expect(revoked.statusCode).toBe(204);

    const aliceSaw = await aliceClient.dispatch<{
      guildId: string;
      member: { userId: string; roleIds: string[] };
    }>("GUILD_MEMBER_UPDATE");
    expect(aliceSaw.guildId).toBe(rolesGuildId);
    expect(aliceSaw.member.userId).toBe(bob.id);
    expect(aliceSaw.member.roleIds).toEqual([]);

    const bobSaw = await bobClient.dispatch<{
      member: { userId: string; roleIds: string[] };
    }>("GUILD_MEMBER_UPDATE");
    expect(bobSaw.member.roleIds).toEqual([]);

    // Gán lại → event mang đúng role vừa gán.
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${rolesGuildId}/members/${bob.id}/roles/${helperId}`,
      headers: auth(alice.token),
    });
    const reassigned = await aliceClient.dispatch<{ member: { roleIds: string[] } }>(
      "GUILD_MEMBER_UPDATE",
    );
    expect(reassigned.member.roleIds).toEqual([helperId]);
  });

  it("overwrite mở quyền xem → CHANNEL_CREATE + PERMISSIONS_UPDATE; thu lại → CHANNEL_DELETE", async () => {
    const ogGuildId = await createGuild(ctx, alice.token, "Overwrite live");
    const ogGeneralId = (await listChannels(ctx, alice.token, ogGuildId))[0]!.id;
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${ogGuildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: ogGeneralId },
    });
    const { code } = invite.json<{ code: string }>();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });

    const secret = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${ogGuildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "secret", type: "guild_text" },
    });
    expect(secret.statusCode).toBe(201);
    const secretId = secret.json<{ id: string }>().id;

    const roles = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${ogGuildId}/roles`,
      headers: auth(alice.token),
    });
    const ogEveryoneId = roles
      .json<Array<{ id: string; isEveryone: boolean }>>()
      .find((role) => role.isEveryone)!.id;
    // Ẩn kênh với mọi người (SEND cũng deny để kiểm tra overwrite allow chỉ mở đúng bit).
    const hide = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${secretId}/overwrites/role/${ogEveryoneId}`,
      headers: auth(alice.token),
      payload: {
        allow: "0",
        deny: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
      },
    });
    expect(hide.statusCode).toBe(200);

    const { client: aliceClient, ready: aliceReady } = await connectAndIdentify(alice);
    const { client: bobClient, ready: bobReady } = await connectAndIdentify(bob);
    expect(aliceReady.guilds.find((g) => g.guild.id === ogGuildId)!.channels.map((c) => c.id)).toContain(
      secretId,
    );
    expect(bobReady.guilds.find((g) => g.guild.id === ogGuildId)!.channels.map((c) => c.id)).not.toContain(
      secretId,
    );

    // Allow riêng cho bob → session đang mở thấy kênh xuất hiện ngay.
    const allow = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${secretId}/overwrites/member/${bob.id}`,
      headers: auth(alice.token),
      payload: {
        allow: serializePermissions(Permission.VIEW_CHANNEL),
        deny: "0",
      },
    });
    expect(allow.statusCode).toBe(200);

    const appeared = await bobClient.dispatch<{ id: string }>("CHANNEL_CREATE");
    expect(appeared.id).toBe(secretId);
    const perms = await waitForPermsUpdate(
      bobClient,
      (map) =>
        map[secretId] !== undefined &&
        hasPermission(parsePermissions(map[secretId]), Permission.VIEW_CHANNEL),
    );
    // Chỉ VIEW được mở; SEND vẫn bị @everyone deny.
    expect(hasPermission(parsePermissions(perms[secretId] ?? "0"), Permission.SEND_MESSAGES)).toBe(
      false,
    );

    // Đặt lại overwrite → mất quyền xem, kênh biến mất khỏi sidebar.
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${secretId}/overwrites/member/${bob.id}`,
      headers: auth(alice.token),
      payload: { allow: "0", deny: "0" },
    });
    const removed = await bobClient.dispatch<{ id: string }>("CHANNEL_DELETE");
    expect(removed.id).toBe(secretId);

    expect(aliceClient.lastSeq).toBeGreaterThan(0);
  });

  it("overwrite trên category ẩn kênh con; allow ở category làm nó xuất hiện", async () => {
    const guildId2 = await createGuild(ctx, alice.token, "Category live");
    const general2 = (await listChannels(ctx, alice.token, guildId2))[0]!.id;
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId2}/invites`,
      headers: auth(alice.token),
      payload: { channelId: general2 },
    });
    const { code } = invite.json<{ code: string }>();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });

    const category = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId2}/channels`,
      headers: auth(alice.token),
      payload: { name: "Hidden", type: "category" },
    });
    const categoryId = category.json<{ id: string }>().id;
    const child = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId2}/channels`,
      headers: auth(alice.token),
      payload: { name: "child", type: "guild_text", parentId: categoryId },
    });
    const childId = child.json<{ id: string }>().id;

    const roles = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId2}/roles`,
      headers: auth(alice.token),
    });
    const everyoneId = roles
      .json<Array<{ id: string; isEveryone: boolean }>>()
      .find((role) => role.isEveryone)!.id;
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${categoryId}/overwrites/role/${everyoneId}`,
      headers: auth(alice.token),
      payload: {
        allow: "0",
        deny: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
      },
    });

    const { client: bobClient, ready: bobReady } = await connectAndIdentify(bob);
    const bobChannels = bobReady.guilds.find((g) => g.guild.id === guildId2)!.channels;
    expect(bobChannels.map((channel) => channel.id)).not.toContain(childId);
    expect(bobChannels.map((channel) => channel.id)).not.toContain(categoryId);

    // Allow ở chính category → cả category và kênh con xuất hiện, quyền kế thừa xuống con.
    const allow = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${categoryId}/overwrites/member/${bob.id}`,
      headers: auth(alice.token),
      payload: { allow: serializePermissions(Permission.VIEW_CHANNEL), deny: "0" },
    });
    expect(allow.statusCode).toBe(200);

    const appeared = await bobClient.next(
      (frame) =>
        frame.op === 0 &&
        frame.t === "CHANNEL_CREATE" &&
        (frame.d as { id: string }).id === childId,
    );
    expect((appeared.d as { id: string }).id).toBe(childId);

    const perms = await waitForPermsUpdate(
      bobClient,
      (map) =>
        map[childId] !== undefined &&
        hasPermission(parsePermissions(map[childId]), Permission.VIEW_CHANNEL),
    );
    // SEND vẫn bị deny từ category — allow ở member chỉ mở đúng bit được cấp.
    expect(hasPermission(parsePermissions(perms[childId] ?? "0"), Permission.SEND_MESSAGES)).toBe(
      false,
    );

    // Đặt lại overwrite của category → kênh con biến mất khỏi session đang mở.
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${categoryId}/overwrites/member/${bob.id}`,
      headers: auth(alice.token),
      payload: { allow: "0", deny: "0" },
    });
    const removed = await bobClient.next(
      (frame) =>
        frame.op === 0 &&
        frame.t === "CHANNEL_DELETE" &&
        (frame.d as { id: string }).id === childId,
    );
    expect((removed.d as { id: string }).id).toBe(childId);
  });
});
