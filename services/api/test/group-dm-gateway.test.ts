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

/**
 * Group DM phải sống động: người được mời thấy nhóm ngay, tin nhắn tới mọi
 * thành viên, và người bị mời ra thì **ngừng** nhận tin của nhóm.
 */

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

  alice = await registerUser(ctx, "gdm_gw_alice");
  bob = await registerUser(ctx, "gdm_gw_bob");
  carol = await registerUser(ctx, "gdm_gw_carol");
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

interface SummaryBody {
  channel: { id: string; type: string; name: string | null };
  recipients: { userId: string }[];
  ownerId: string | null;
  name: string | null;
}

describe("group DM realtime", () => {
  it("mời vào nhóm → người được mời nhận DM_CHANNEL_CREATE; tin nhắn tới cả nhóm", async () => {
    const bobClient = await connect(bob);
    const carolClient = await connect(carol);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientIds: [bob.id, carol.id] },
    });
    expect(created.statusCode).toBe(201);
    const channelId = created.json<SummaryBody>().channel.id;

    // Mỗi người nhận summary theo góc nhìn của mình (không có chính họ).
    const forBob = await bobClient.dispatch<SummaryBody>("DM_CHANNEL_CREATE");
    expect(forBob.channel.id).toBe(channelId);
    expect(forBob.recipients.map((entry) => entry.userId).sort()).toEqual(
      [alice.id, carol.id].sort(),
    );
    const forCarol = await carolClient.dispatch<SummaryBody>("DM_CHANNEL_CREATE");
    expect(forCarol.channel.id).toBe(channelId);

    // Tin nhắn trong nhóm tới được người thứ ba, không cần họ mở kênh trước.
    await sendMessage(ctx, alice.token, channelId, "họp lúc 9h");
    const seen = await bobClient.dispatch<{ content: string; channelId: string }>("MESSAGE_CREATE");
    expect(seen.channelId).toBe(channelId);
    expect(seen.content).toBe("họp lúc 9h");
    await carolClient.dispatch<{ channelId: string }>("MESSAGE_CREATE");
  });

  it("đổi tên nhóm → mọi thành viên nhận DM_CHANNEL_UPDATE", async () => {
    const bobClient = await connect(bob);
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/users/@me/channels",
        headers: auth(alice.token),
        payload: { recipientIds: [bob.id, carol.id] },
      })
    ).json<SummaryBody>();
    await bobClient.dispatch<SummaryBody>("DM_CHANNEL_CREATE");

    const renamed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${created.channel.id}`,
      headers: auth(alice.token),
      payload: { name: "Nhóm cuối tuần" },
    });
    expect(renamed.statusCode).toBe(200);

    const update = await bobClient.dispatch<SummaryBody>("DM_CHANNEL_UPDATE");
    expect(update.channel.id).toBe(created.channel.id);
    expect(update.name).toBe("Nhóm cuối tuần");
    expect(update.channel.name).toBe("Nhóm cuối tuần");
  });

  it("bị mời ra khỏi nhóm → nhận CHANNEL_DELETE và không nhận tin mới", async () => {
    const carolClient = await connect(carol);
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/users/@me/channels",
        headers: auth(alice.token),
        payload: { recipientIds: [bob.id, carol.id] },
      })
    ).json<SummaryBody>();
    const channelId = created.channel.id;
    await carolClient.dispatch<SummaryBody>("DM_CHANNEL_CREATE");

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/recipients/${carol.id}`,
      headers: auth(alice.token),
    });
    expect(removed.statusCode).toBe(204);

    // Client hiểu `guildId: null` là bỏ DM/group khỏi sidebar.
    const closed = await carolClient.dispatch<{ id: string; guildId: string | null }>(
      "CHANNEL_DELETE",
    );
    expect(closed.id).toBe(channelId);
    expect(closed.guildId).toBeNull();

    // Tin mới không được đẩy cho người đã ra.
    await sendMessage(ctx, bob.token, channelId, "tin sau khi carol ra");
    const pending = await carolClient.next(
      (frame) =>
        frame.op === 0 &&
        frame.t === "MESSAGE_CREATE" &&
        (frame.d as { channelId: string }).channelId === channelId,
      300,
    ).catch(() => null);
    expect(pending).toBeNull();
  });

  it("group DM không bị ẩn khi hai người trong nhóm chặn nhau (khác DM 1-1)", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/users/@me/channels",
        headers: auth(alice.token),
        payload: { recipientIds: [bob.id, carol.id] },
      })
    ).json<SummaryBody>();

    // Carol chặn Alice — nhóm vẫn phải còn với cả hai (block là chuyện hai người).
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(carol.token),
    });

    const forAlice = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
    });
    const ids = forAlice.json<SummaryBody[]>().map((dm) => dm.channel.id);
    expect(ids).toContain(created.channel.id);

    // Nhưng vẫn mở được lịch sử nhóm (không bị coi là DM bị chặn).
    const history = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${created.channel.id}/messages`,
      headers: auth(alice.token),
    });
    expect(history.statusCode).toBe(200);

    // Dọn dẹp: bỏ chặn để các test khác không bị ảnh hưởng.
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(carol.token),
    });
  });

  it("DM 1-1 vẫn bị ẩn khi chặn (hành vi cũ không đổi)", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const dmId = dm.json<SummaryBody>().channel.id;

    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(bob.token),
    });
    const forAlice = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
    });
    expect(forAlice.json<SummaryBody[]>().map((item) => item.channel.id)).not.toContain(dmId);
    const history = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${dmId}/messages`,
      headers: auth(alice.token),
    });
    expect(history.json<unknown[]>()).toEqual([]);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(bob.token),
    });
  });

  it("kênh server không bị ảnh hưởng bởi các thay đổi trên", async () => {
    const guildId = await createGuild(ctx, alice.token, "Group DM không đụng server");
    const channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
  });
});
