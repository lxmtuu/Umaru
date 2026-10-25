import { GatewayOpcode } from "@umaru/protocol";
import type { AddressInfo } from "node:net";
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
let carol: RegisteredUser;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  carol = await registerUser(ctx, "carol");

  // bob và carol tham gia guild của alice qua invite (cần cho test "không thấy DM lạ")
  const guildId = await createGuild(ctx, alice.token);
  const generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
  for (const member of [bob, carol]) {
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: generalId },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
      headers: auth(member.token),
    });
  }
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

async function connect(
  user: RegisteredUser,
): Promise<{ client: GatewayTestClient; ready: { dms: Array<{ channel: { id: string }; recipient: { userId: string } }> } }> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: GatewayOpcode.Identify, d: { token: user.token } });
  const ready = await client.dispatch<{ dms: Array<{ channel: { id: string }; recipient: { userId: string } }> }>("READY");
  return { client, ready };
}

describe("DM 1-1", () => {
  it("tạo DM trả 201 lần đầu, 200 khi lặp lại và không tạo trùng", async () => {
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json<{ channel: { id: string; type: string; guildId: string | null }; recipient: { userId: string; displayName: string } }>();
    expect(created.channel.type).toBe("dm");
    expect(created.channel.guildId).toBeNull();
    expect(created.recipient).toMatchObject({ userId: bob.id, displayName: "bob" });

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ channel: { id: string } }>().channel.id).toBe(created.channel.id);

    // bob cũng thấy đúng một DM với alice
    const bobList = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/channels",
      headers: auth(bob.token),
    });
    expect(bobList.statusCode).toBe(200);
    const bobDms = bobList.json<Array<{ channel: { id: string }; recipient: { userId: string } }>>();
    expect(bobDms).toHaveLength(1);
    expect(bobDms[0]?.channel.id).toBe(created.channel.id);
    expect(bobDms[0]?.recipient.userId).toBe(alice.id);

    const rows = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM channels WHERE type = 'dm'",
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("tự nhắn cho mình / người không tồn tại bị từ chối", async () => {
    const self = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: alice.id },
    });
    expect(self.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: "999999999999999999" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("hai bên nhắn được cho nhau, người thứ ba không đọc được", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const channelId = dm.json<{ channel: { id: string } }>().channel.id;

    const sent = await sendMessage(ctx, alice.token, channelId, "chỉ bob thấy tin này");
    expect(sent.id.length).toBeGreaterThan(10);

    const bobReads = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(bob.token),
    });
    expect(bobReads.statusCode).toBe(200);
    expect(bobReads.json<Array<{ content: string }>>()[0]?.content).toBe("chỉ bob thấy tin này");

    const carolReads = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(carol.token),
    });
    expect(carolReads.statusCode).toBe(404);

    const carolSends = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(carol.token),
      payload: { content: "xâm nhập" },
    });
    expect(carolSends.statusCode).toBe(404);
  });

  it("READY kèm danh sách DM; hai client đang mở đều nhận tin DM realtime", async () => {
    const { client: aliceClient, ready: aliceReady } = await connect(alice);
    const { client: bobClient } = await connect(bob);
    const { client: carolClient } = await connect(carol);

    // READY của alice có sẵn DM với bob
    expect(aliceReady.dms.length).toBeGreaterThanOrEqual(1);
    expect(aliceReady.dms[0]?.recipient.userId).toBe(bob.id);

    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: carol.id },
    });
    expect(dm.statusCode).toBe(201);
    const carolChannelId = dm.json<{ channel: { id: string } }>().channel.id;

    // carol (đang online) nhận DM_CHANNEL_CREATE dù không gọi REST
    const created = await carolClient.dispatch<{ channel: { id: string }; recipient: { userId: string } }>(
      "DM_CHANNEL_CREATE",
    );
    expect(created.channel.id).toBe(carolChannelId);
    expect(created.recipient.userId).toBe(alice.id);

    // fan-out tin nhắn DM: hai client trong DM thấy, client ngoài không thấy
    const message = await sendMessage(ctx, alice.token, carolChannelId, "hello DM");
    const forCarol = await carolClient.dispatch<{ id: string; content: string; channelId: string }>(
      "MESSAGE_CREATE",
    );
    expect(forCarol).toMatchObject({ id: message.id, content: "hello DM", channelId: carolChannelId });

    const forAlice = await aliceClient.dispatch<{ id: string; content: string }>("MESSAGE_CREATE");
    expect(forAlice.id).toBe(message.id);

    await bobClient.expectNoDispatch("MESSAGE_CREATE", 400);
    await carolClient.expectNoDispatch("DM_CHANNEL_CREATE", 200);

    // Mở lại DM đã có không được phát DM_CHANNEL_CREATE lần nữa (tránh client
    // bên kia tự nhảy vào cuộc và xoá badge chưa đọc).
    const reopen = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: carol.id },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json<{ channel: { id: string } }>().channel.id).toBe(carolChannelId);
    await carolClient.expectNoDispatch("DM_CHANNEL_CREATE", 300);
  });
});
