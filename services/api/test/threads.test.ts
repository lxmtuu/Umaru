import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayOpcode, type Message, type ThreadSummary } from "@umaru/protocol";
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
 * Thread.
 *
 * Điều đáng kiểm không phải "tạo được thread" mà là những chỗ dễ hỏng âm thầm:
 *  - thread **không** lọt vào sidebar (nếu lọt, nó nằm giữa các kênh và làm hỏng
 *    thứ tự kéo–thả);
 *  - tin trong thread vẫn fan-out tới người đang mở kênh cha (đây là lý do
 *    `visibleChannels` phải bao gồm thread — quên là "gửi mà không ai thấy");
 *  - thread đã lưu trữ **không** nhận tin mới, và tự lưu trữ khi im lặng quá hạn;
 *  - quyền kế thừa từ kênh cha (người bị chặn xem kênh cha không đọc được thread).
 */

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let carol: RegisteredUser;
let guildId = "";
let channelId = "";
let wsUrl = "";
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext({ THREAD_ARCHIVE_MINUTES: "60" });
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  wsUrl = `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "thread_alice");
  bob = await registerUser(ctx, "thread_bob");
  carol = await registerUser(ctx, "thread_carol");
  guildId = await createGuild(ctx, alice.token, "Thread Server");
  channelId = (await listChannels(ctx, alice.token, guildId)).find((c) => c.type === "guild_text")!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const code = invite.json<{ code: string }>().code;
  for (const member of [bob, carol]) {
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(member.token),
    });
  }
  // Chỉ Carol bị chặn xem kênh này (deny theo **member**, không theo @everyone —
  // nếu deny @everyone thì Bob cũng mất quyền và các test fan-out sẽ vô nghĩa).
  await ctx.app.inject({
    method: "PUT",
    url: `/api/v1/channels/${channelId}/overwrites/member/${carol.id}`,
    headers: auth(alice.token),
    payload: { allow: "0", deny: "1" }, // deny VIEW_CHANNEL
  });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

async function createThread(
  token: string,
  parentId: string,
  payload: Record<string, unknown> = {},
): Promise<ThreadSummary> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${parentId}/threads`,
    headers: auth(token),
    payload,
  });
  if (response.statusCode !== 201) throw new Error(`tạo thread lỗi: ${response.body}`);
  return response.json<ThreadSummary>();
}

function listThreads(token: string, parentId: string, archived = false) {
  return ctx.app.inject({
    method: "GET",
    url: `/api/v1/channels/${parentId}/threads${archived ? "?archived=1" : ""}`,
    headers: auth(token),
  });
}

describe("thread", () => {
  it("tạo thread từ tin nhắn: tên lấy từ tin gốc, tin gốc được ghi lại", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "Bàn về migration 0017\nchi tiết");
    const thread = await createThread(alice.token, channelId, { messageId: message.id });

    expect(thread.parentChannelId).toBe(channelId);
    expect(thread.rootMessageId).toBe(message.id);
    expect(thread.name).toBe("Bàn về migration 0017");
    expect(thread.messageCount).toBe(0);
    expect(thread.archived).toBe(false);
    expect(thread.ownerId).toBe(alice.id);
  });

  it("thread không lọt vào sidebar nhưng gửi/nhận tin được", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Sidebar check" });
    const sidebar = await listChannels(ctx, alice.token, guildId);
    expect(sidebar.some((channel) => channel.id === thread.id)).toBe(false);

    const sent = await sendMessage(ctx, alice.token, thread.id, "tin trong thread");
    const listed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${thread.id}/messages`,
      headers: auth(alice.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<Message[]>().some((m) => m.id === sent.id)).toBe(true);
  });

  it("tin mới trong thread fan-out tới người đang mở kênh cha", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Fan-out" });
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: GatewayOpcode.Identify, d: { token: bob.token } });
    const ready = await client.dispatch("READY");

    // Bob biết thread ngay từ READY (kèm theo server), dù nó không nằm ở sidebar.
    const threads = (ready as { threads?: ThreadSummary[] }).threads ?? [];
    expect(threads.some((entry) => entry.id === thread.id)).toBe(true);

    await sendMessage(ctx, alice.token, thread.id, "ai ở đó không");
    const event = (await client.dispatch("MESSAGE_CREATE")) as { channelId: string; content: string };
    expect(event.channelId).toBe(thread.id);
    expect(event.content).toBe("ai ở đó không");
  }, 20_000);

  it("thread tạo lúc đang online cũng tới client qua THREAD_CREATE", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: GatewayOpcode.Identify, d: { token: bob.token } });
    await client.dispatch("READY");

    const thread = await createThread(alice.token, channelId, { name: "Live thread" });
    const event = (await client.dispatch("THREAD_CREATE")) as ThreadSummary;
    expect(event.id).toBe(thread.id);
    expect(event.name).toBe("Live thread");
  }, 20_000);

  it("một tin nhắn chỉ có một thread đang mở", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "tin gốc duy nhất");
    await createThread(alice.token, channelId, { messageId: message.id });
    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/threads`,
      headers: auth(alice.token),
      payload: { messageId: message.id },
    });
    expect(again.statusCode).toBe(409);
  });

  it("lưu trữ: chặn gửi tin, ẩn khỏi danh sách mở, hiện ở danh sách lưu trữ", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Sẽ lưu trữ" });
    const archived = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${thread.id}/thread`,
      headers: auth(alice.token),
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<ThreadSummary>().archived).toBe(true);

    const blocked = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${thread.id}/messages`,
      headers: auth(alice.token),
      payload: { content: "còn gửi được không" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe("THREAD_ARCHIVED");

    const active = (await listThreads(alice.token, channelId)).json<ThreadSummary[]>();
    expect(active.some((entry) => entry.id === thread.id)).toBe(false);
    const stored = (await listThreads(alice.token, channelId, true)).json<ThreadSummary[]>();
    expect(stored.some((entry) => entry.id === thread.id)).toBe(true);

    // Mở lại thì gửi được, và về lại danh sách đang mở.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${thread.id}/thread`,
      headers: auth(alice.token),
      payload: { archived: false },
    });
    const reopened = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${thread.id}/messages`,
      headers: auth(alice.token),
      payload: { content: "mở lại rồi" },
    });
    expect(reopened.statusCode).toBe(201);
  });

  it("thread im lặng quá hạn tự lưu trữ khi mở danh sách", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Im lặng" });
    // Đẩy mốc hoạt động lùi 2 giờ (hạn cấu hình trong test là 60 phút).
    await ctx.pool.query(
      "UPDATE channel_threads SET last_activity_at = now() - interval '2 hours' WHERE channel_id = $1",
      [thread.id],
    );
    const active = (await listThreads(alice.token, channelId)).json<ThreadSummary[]>();
    expect(active.some((entry) => entry.id === thread.id)).toBe(false);
    const stored = (await listThreads(alice.token, channelId, true)).json<ThreadSummary[]>();
    expect(stored.some((entry) => entry.id === thread.id)).toBe(true);
  });

  it("đếm tin + hoạt động cập nhật khi gửi và khi xoá", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Đếm" });
    const first = await sendMessage(ctx, alice.token, thread.id, "một");
    await sendMessage(ctx, alice.token, thread.id, "hai");
    const after = (await listThreads(alice.token, channelId)).json<ThreadSummary[]>();
    expect(after.find((entry) => entry.id === thread.id)?.messageCount).toBe(2);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${first.id}`,
      headers: auth(alice.token),
    });
    const afterDelete = (await listThreads(alice.token, channelId)).json<ThreadSummary[]>();
    expect(afterDelete.find((entry) => entry.id === thread.id)?.messageCount).toBe(1);
  });

  it("quyền kế thừa từ kênh cha: người không xem được kênh cha không thấy thread", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Riêng tư" });
    const asCarol = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${thread.id}/messages`,
      headers: auth(carol.token),
    });
    expect(asCarol.statusCode).toBe(404);
    const listAsCarol = await listThreads(carol.token, channelId);
    expect(listAsCarol.statusCode).toBe(404);
  });

  it("chỉ chủ thread hoặc MANAGE_CHANNELS được đổi; người khác 403", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Quyền đổi" });
    const denied = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${thread.id}/thread`,
      headers: auth(bob.token),
      payload: { archived: true },
    });
    expect(denied.statusCode).toBe(403);

    const renamed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${thread.id}/thread`,
      headers: auth(alice.token),
      payload: { name: "Tên mới" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ThreadSummary>().name).toBe("Tên mới");
  });

  it("route kênh từ chối sửa/xoá thread (phải dùng route thread)", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Route" });
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${thread.id}`,
      headers: auth(alice.token),
      payload: { name: "Sai route" },
    });
    expect(patch.statusCode).toBe(400);
    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${thread.id}`,
      headers: auth(alice.token),
    });
    expect(remove.statusCode).toBe(400);
  });

  it("xoá thread: mất tin nhắn của nó, danh sách sạch, client nhận THREAD_DELETE", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Xoá" });
    await sendMessage(ctx, alice.token, thread.id, "sẽ biến mất");

    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: GatewayOpcode.Identify, d: { token: bob.token } });
    await client.dispatch("READY");

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${thread.id}/thread`,
      headers: auth(alice.token),
    });
    expect(removed.statusCode).toBe(204);

    const event = (await client.dispatch("THREAD_DELETE")) as { id: string };
    expect(event.id).toBe(thread.id);

    const messagesLeft = await ctx.pool.query(
      "SELECT 1 FROM messages WHERE channel_id = $1",
      [thread.id],
    );
    expect(messagesLeft.rowCount).toBe(0);
    const listed = (await listThreads(alice.token, channelId)).json<ThreadSummary[]>();
    expect(listed.some((entry) => entry.id === thread.id)).toBe(false);
  }, 20_000);

  it("không tạo được thread trong thread, hay trong kênh thoại", async () => {
    const thread = await createThread(alice.token, channelId, { name: "Cha" });
    const nested = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${thread.id}/threads`,
      headers: auth(alice.token),
      payload: {},
    });
    expect(nested.statusCode).toBe(400);

    const voice = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "Voice", type: "guild_voice" },
    });
    const voiceId = voice.json<{ id: string }>().id;
    const inVoice = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${voiceId}/threads`,
      headers: auth(alice.token),
      payload: {},
    });
    expect(inVoice.statusCode).toBe(400);
  });
});
