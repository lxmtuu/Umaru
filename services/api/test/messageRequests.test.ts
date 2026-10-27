import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  auth,
  createTestContext,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Yêu cầu nhắn tin (message requests).
 *
 * Người đặt `dm_privacy = 'friends'` nhận cuộc mở mới dưới dạng **yêu cầu chờ
 * duyệt**: kênh có thật trong DB nhưng không nằm trong danh sách của họ và không
 * fan-out tin nhắn cho họ cho tới khi đồng ý. Đây là điểm dễ sai nhất — test phải
 * kiểm cả "không thấy" (danh sách + event) chứ không chỉ mã HTTP.
 */

let ctx: TestContext;
let wsUrl: string;
let host: RegisteredUser; // đặt dm_privacy = 'friends'
let stranger: RegisteredUser;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  host = await registerUser(ctx, "mr_host");
  stranger = await registerUser(ctx, "mr_stranger");
  const patched = await ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/users/@me/settings",
    headers: auth(host.token),
    payload: { dmPrivacy: "friends" },
  });
  expect(patched.statusCode).toBe(200);
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

function openDm(token: string, recipientId: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/users/@me/channels",
    headers: auth(token),
    payload: { recipientId },
  });
}

function listDms(token: string) {
  return ctx.app.inject({ method: "GET", url: "/api/v1/users/@me/channels", headers: auth(token) });
}

function listRequests(token: string) {
  return ctx.app.inject({
    method: "GET",
    url: "/api/v1/users/@me/message-requests",
    headers: auth(token),
  });
}

function accept(token: string, channelId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/users/@me/message-requests/${channelId}/accept`,
    headers: auth(token),
  });
}

function decline(token: string, channelId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/users/@me/message-requests/${channelId}/decline`,
    headers: auth(token),
  });
}

function dmIds(response: { json: <T>() => T }): string[] {
  return response.json<Array<{ channel: { id: string } }>>().map((dm) => dm.channel.id);
}

describe("mở DM với người đặt 'chỉ bạn bè'", () => {
  let channelId = "";

  it("→ tạo yêu cầu chờ duyệt, người nhận không thấy kênh, người gửi thấy cờ requestPending", async () => {
    const created = await openDm(stranger.token, host.id);
    expect(created.statusCode).toBe(201);
    const summary = created.json<{ channel: { id: string }; requestPending: boolean }>();
    channelId = summary.channel.id;
    expect(summary.requestPending).toBe(true);

    expect(dmIds(await listDms(stranger.token))).toContain(channelId);
    expect(dmIds(await listDms(host.token))).not.toContain(channelId);
  });

  it("người nhận thấy nó trong danh sách yêu cầu, kèm người gửi + preview", async () => {
    const requests = (await listRequests(host.token)).json<
      Array<{ channelId: string; sender: { username: string }; preview: string | null; messageCount: number }>
    >();
    const mine = requests.find((row) => row.channelId === channelId);
    expect(mine?.sender.username).toBe(stranger.username);
    expect(mine?.preview).toBeNull();
    expect(mine?.messageCount).toBe(0);

    // Người gửi không tự thấy yêu cầu của chính mình.
    expect((await listRequests(stranger.token)).json<unknown[]>()).toHaveLength(0);
  });

  it("tin nhắn trong yêu cầu chưa duyệt KHÔNG tới người nhận (không list, không event)", async () => {
    const hostClient = await connect(host);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(stranger.token),
      payload: { content: "Chào bạn, mình muốn hỏi chút" },
    });
    expect(sent.statusCode).toBe(201);

    // Không có event: kênh không nằm trong `visibleChannels` của host.
    await hostClient.expectNoDispatch("MESSAGE_CREATE");
    // Preview trong danh sách yêu cầu vẫn cập nhật để host quyết định.
    const requests = (await listRequests(host.token)).json<
      Array<{ channelId: string; preview: string | null; messageCount: number }>
    >();
    const mine = requests.find((row) => row.channelId === channelId);
    expect(mine?.preview).toContain("Chào bạn");
    expect(mine?.messageCount).toBe(1);
  });

  it("chỉ người nhận xử lý được: người gửi accept/decline → 404", async () => {
    expect((await accept(stranger.token, channelId)).statusCode).toBe(404);
    expect((await decline(stranger.token, channelId)).statusCode).toBe(404);
  });

  it("đồng ý → DM hiện ra với người nhận, đọc được lịch sử, yêu cầu biến mất", async () => {
    const hostClient = await connect(host);
    const accepted = await accept(host.token, channelId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ requestPending: boolean }>().requestPending).toBe(false);

    const removeEvent = await hostClient.dispatch<{ channelId: string }>("MESSAGE_REQUEST_REMOVE");
    expect(removeEvent.channelId).toBe(channelId);
    const created = await hostClient.dispatch<{ channel: { id: string } }>("DM_CHANNEL_CREATE");
    expect(created.channel.id).toBe(channelId);

    expect(dmIds(await listDms(host.token))).toContain(channelId);
    expect((await listRequests(host.token)).json<unknown[]>()).toHaveLength(0);

    // Tin gửi trước khi duyệt vẫn còn — người nhận đọc được để quyết định.
    const messages = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(host.token),
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json<Array<{ content: string }>>()[0]?.content).toContain("Chào bạn");

    // Đã duyệt rồi thì accept lần hai là 404, không phát lại event.
    expect((await accept(host.token, channelId)).statusCode).toBe(404);
  });

  it("sau khi duyệt, tin nhắn mới tới được người nhận", async () => {
    const hostClient = await connect(host);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(stranger.token),
      payload: { content: "Cảm ơn bạn" },
    });
    expect(sent.statusCode).toBe(201);
    const event = await hostClient.dispatch<{ content: string }>("MESSAGE_CREATE");
    expect(event.content).toBe("Cảm ơn bạn");
  });
});

describe("từ chối yêu cầu", () => {
  it("xoá hẳn cuộc trò chuyện cho cả hai + phát CHANNEL_DELETE cho người gửi", async () => {
    // Tạo một yêu cầu mới ở cặp khác để test riêng đường từ chối.
    const other = await registerUser(ctx, "mr_other");
    // `CHANNEL_DELETE` đi tới **người gửi** yêu cầu (cuộc của họ biến mất).
    const otherClient = await connect(other);
    const fresh = await openDm(other.token, host.id);
    expect(fresh.statusCode).toBe(201);
    const freshId = fresh.json<{ channel: { id: string } }>().channel.id;

    const denied = await decline(host.token, freshId);
    expect(denied.statusCode).toBe(204);

    const deleted = await otherClient.dispatch<{ id: string; guildId: string | null }>(
      "CHANNEL_DELETE",
    );
    expect(deleted.id).toBe(freshId);
    expect(deleted.guildId).toBeNull();

    // Không còn ai đọc được kênh này.
    for (const token of [host.token, other.token]) {
      const messages = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${freshId}/messages`,
        headers: auth(token),
      });
      expect(messages.statusCode).toBe(404);
    }
    expect(dmIds(await listDms(other.token))).not.toContain(freshId);
    expect((await listRequests(host.token)).json<unknown[]>()).toHaveLength(0);

    // Từ chối lần hai → 404 (yêu cầu đã biến mất, không phải 500).
    expect((await decline(host.token, freshId)).statusCode).toBe(404);
  });

  it("từ chối rồi vẫn mở lại được một cuộc mới (không bị chặn vĩnh viễn)", async () => {
    const other = await registerUser(ctx, "mr_again");
    const first = await openDm(other.token, host.id);
    expect(first.statusCode).toBe(201);
    expect((await decline(host.token, first.json<{ channel: { id: string } }>().channel.id)).statusCode).toBe(
      204,
    );
    const second = await openDm(other.token, host.id);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ requestPending: boolean }>().requestPending).toBe(true);
  });
});

describe("giới hạn & tương tác với các tính năng khác", () => {
  it("chặn người gửi → yêu cầu biến khỏi danh sách chờ", async () => {
    const blocked = await registerUser(ctx, "mr_blocked");
    const created = await openDm(blocked.token, host.id);
    expect(created.statusCode).toBe(201);
    const channelId = created.json<{ channel: { id: string } }>().channel.id;
    expect(
      (await listRequests(host.token)).json<Array<{ channelId: string }>>().some(
        (row) => row.channelId === channelId,
      ),
    ).toBe(true);

    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${blocked.id}`,
      headers: auth(host.token),
    });
    expect(
      (await listRequests(host.token)).json<Array<{ channelId: string }>>().some(
        (row) => row.channelId === channelId,
      ),
    ).toBe(false);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/blocks/${blocked.id}`,
      headers: auth(host.token),
    });
  });

  it("người mặc định 'everyone' nhận DM luôn, không sinh yêu cầu", async () => {
    const open = await registerUser(ctx, "mr_open");
    const created = await openDm(stranger.token, open.id);
    expect(created.statusCode).toBe(201);
    expect(created.json<{ requestPending: boolean }>().requestPending).toBe(false);
    expect((await listRequests(open.token)).json<unknown[]>()).toHaveLength(0);
    expect(dmIds(await listDms(open.token))).toContain(
      created.json<{ channel: { id: string } }>().channel.id,
    );
  });

  it("trần 5 yêu cầu đang chờ → 409 khi gửi thêm, đồng ý một cái là có chỗ", async () => {
    const spammer = await registerUser(ctx, "mr_spammer");
    const targets: RegisteredUser[] = [];
    for (let i = 0; i < 5; i += 1) {
      const target = await registerUser(ctx, `mr_t${i}`);
      // Chỉ người đặt "chỉ bạn bè" mới sinh yêu cầu — nếu để mặc định thì mở
      // DM là vào thẳng và không bao giờ chạm trần.
      await ctx.app.inject({
        method: "PATCH",
        url: "/api/v1/users/@me/settings",
        headers: auth(target.token),
        payload: { dmPrivacy: "friends" },
      });
      targets.push(target);
      const created = await openDm(spammer.token, target.id);
      expect(created.statusCode).toBe(201);
    }
    const sixth = await openDm(spammer.token, host.id);
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json<{ error: { message: string } }>().error.message).toContain("yêu cầu nhắn tin");

    // Được duyệt một yêu cầu là có chỗ trống cho yêu cầu tiếp theo.
    const firstPending = (await listRequests(targets[0]!.token)).json<Array<{ channelId: string }>>();
    expect((await accept(targets[0]!.token, firstPending[0]!.channelId)).statusCode).toBe(200);
    expect((await openDm(spammer.token, host.id)).statusCode).toBe(201);
  });
});
