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
 * `READ_STATE_UPDATE` — đọc trên một thiết bị thì thiết bị kia tắt badge ngay.
 *
 * Trước đây mốc đã đọc chỉ được đẩy tới tab khác khi tab đó mở lại kênh hoặc
 * reconnect, nên badge "chưa đọc" nằm lại sai. Test dùng **hai session của cùng
 * một người** và kiểm cả việc người khác không nhận event.
 */

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let channelId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "rs_alice");
  bob = await registerUser(ctx, "rs_bob");
  const guildId = await createGuild(ctx, alice.token);
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

describe("READ_STATE_UPDATE", () => {
  it("ack ở một session → session còn lại của cùng người nhận state đã đọc, người khác thì không", async () => {
    const laptop = await connect(alice);
    const phone = await connect(alice);
    const bobClient = await connect(bob);

    const message = await sendMessage(ctx, bob.token, channelId, "tin để alice đọc");
    // Cả hai session của alice đều nhận tin (fan-out theo kênh).
    await laptop.dispatch("MESSAGE_CREATE");
    await phone.dispatch("MESSAGE_CREATE");

    // Alice đọc trên "laptop".
    const ack = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/read`,
      headers: auth(alice.token),
      payload: { messageId: message.id },
    });
    expect(ack.statusCode).toBe(204);

    const event = await phone.dispatch<{
      channelId: string;
      lastReadMessageId: string;
      unread: number;
      mentions: number;
    }>("READ_STATE_UPDATE");
    expect(event.channelId).toBe(channelId);
    expect(event.lastReadMessageId).toBe(message.id);
    expect(event.unread).toBe(0);
    expect(event.mentions).toBe(0);

    // Người khác không bao giờ nhận mốc đã đọc của mình.
    await bobClient.expectNoDispatch("READ_STATE_UPDATE");
  });

  it("tin mới sau khi ack → unread trong event là số tin còn lại, không phải 0", async () => {
    const phone = await connect(alice);
    await sendMessage(ctx, bob.token, channelId, "tin một");
    // READ_STATE_UPDATE của lần ack trước có thể còn trong hàng đợi của session
    // cũ; session mới nên nhận đúng event của lần ack này.
    await sendMessage(ctx, bob.token, channelId, "tin hai");

    const first = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/channels/" + channelId + "/messages?limit=1",
      headers: auth(alice.token),
    });
    const newest = first.json<Array<{ id: string }>>()[0]!;

    // Ack tới tin mới nhất rồi mới gửi thêm một tin nữa.
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/read`,
      headers: auth(alice.token),
      payload: { messageId: newest.id },
    });
    await phone.dispatch("READ_STATE_UPDATE");
    await sendMessage(ctx, bob.token, channelId, "tin ba");

    // Ack lại tới đúng tin vừa đọc: unread phải là 1 (chỉ tin thứ ba).
    const second = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/channels/" + channelId + "/messages?limit=1",
      headers: auth(alice.token),
    });
    expect(second.json<Array<{ id: string }>>()[0]!.id).not.toBe(newest.id);

    const partial = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/read`,
      headers: auth(alice.token),
      payload: { messageId: newest.id },
    });
    expect(partial.statusCode).toBe(204);

    // `GREATEST` nên mốc không lùi: event vẫn báo state thật của kênh.
    const event = await phone.dispatch<{ unread: number }>("READ_STATE_UPDATE");
    expect(event.unread).toBe(1);
  });
});
