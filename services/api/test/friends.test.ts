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
 * Bạn bè + quyền riêng tư DM.
 *
 * Trọng tâm: lời mời không tự thành bạn (phải cả hai phía), chặn cắt được quan
 * hệ bạn bè, và cổng privacy chỉ chặn **mở DM mới** — không cắt ngang cuộc đang có.
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

  alice = await registerUser(ctx, "fr_alice");
  bob = await registerUser(ctx, "fr_bob");
  carol = await registerUser(ctx, "fr_carol");
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

function addFriend(token: string, username: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/users/@me/friends",
    headers: auth(token),
    payload: { username },
  });
}

function listFriends(token: string) {
  return ctx.app.inject({ method: "GET", url: "/api/v1/users/@me/friends", headers: auth(token) });
}

function accept(token: string, userId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/users/@me/friends/${userId}/accept`,
    headers: auth(token),
  });
}

function removeFriend(token: string, userId: string) {
  return ctx.app.inject({
    method: "DELETE",
    url: `/api/v1/users/@me/friends/${userId}`,
    headers: auth(token),
  });
}

function openDm(token: string, recipientId: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/users/@me/channels",
    headers: auth(token),
    payload: { recipientId },
  });
}

function setPrivacy(token: string, dmPrivacy: unknown) {
  return ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/users/@me/settings",
    headers: auth(token),
    payload: { dmPrivacy },
  });
}

describe("lời mời kết bạn", () => {
  it("gửi lời mời → người nhận thấy ở incoming, người gửi ở outgoing, và nhận event", async () => {
    const bobClient = await connect(bob);

    const sent = await addFriend(alice.token, bob.username);
    expect(sent.statusCode).toBe(201);
    expect(sent.json<{ user: { username: string } }>().user.username).toBe(bob.username);

    // Người nhận được báo realtime để hiện badge.
    const event = await bobClient.dispatch<{ user: { username: string } }>("FRIEND_REQUEST_CREATE");
    expect(event.user.username).toBe(alice.username);

    // Chưa phải bạn bè ở cả hai phía — quan trọng: lời mời ≠ kết bạn.
    const aliceList = (await listFriends(alice.token)).json<{
      friends: unknown[];
      outgoing: Array<{ user: { username: string } }>;
    }>();
    expect(aliceList.friends).toHaveLength(0);
    expect(aliceList.outgoing.map((row) => row.user.username)).toEqual([bob.username]);

    const bobList = (await listFriends(bob.token)).json<{
      friends: unknown[];
      incoming: Array<{ user: { username: string } }>;
    }>();
    expect(bobList.friends).toHaveLength(0);
    expect(bobList.incoming.map((row) => row.user.username)).toEqual([alice.username]);
  });

  it("gửi lại lời mời đang chờ → 409, không tạo dòng thứ hai", async () => {
    const again = await addFriend(alice.token, bob.username);
    expect(again.statusCode).toBe(409);
  });

  it("chấp nhận → cả hai thành bạn, người gửi nhận FRIEND_ADD", async () => {
    const aliceClient = await connect(alice);
    const accepted = await accept(bob.token, alice.id);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ user: { username: string } }>().user.username).toBe(alice.username);

    const event = await aliceClient.dispatch<{ user: { username: string } }>("FRIEND_ADD");
    expect(event.user.username).toBe(bob.username);

    // Hai chiều đều thấy nhau.
    for (const token of [alice.token, bob.token]) {
      const list = (await listFriends(token)).json<{
        friends: Array<{ user: { username: string } }>;
        incoming: unknown[];
        outgoing: unknown[];
      }>();
      expect(list.friends).toHaveLength(1);
      expect(list.incoming).toHaveLength(0);
      expect(list.outgoing).toHaveLength(0);
    }
  });

  it("chỉ người nhận chấp nhận được: người gửi tự accept → 404", async () => {
    const self = await accept(alice.token, carol.id);
    expect(self.statusCode).toBe(404);
  });

  it("hai người gửi chéo nhau: lần thứ hai là đồng ý luôn", async () => {
    // carol mời alice, rồi alice mời lại carol.
    expect((await addFriend(carol.token, alice.username)).statusCode).toBe(201);
    const crossed = await addFriend(alice.token, carol.username);
    expect(crossed.statusCode).toBe(200);

    const list = (await listFriends(carol.token)).json<{
      friends: Array<{ user: { username: string } }>;
    }>();
    expect(list.friends.map((row) => row.user.username)).toEqual(["fr_alice"]);
  });

  it("username không tồn tại → 404; tự kết bạn → 400; username rác → 400", async () => {
    expect((await addFriend(alice.token, "khong_ton_tai_xyz")).statusCode).toBe(404);
    expect((await addFriend(alice.token, alice.username)).statusCode).toBe(400);
    expect((await addFriend(alice.token, "Có Dấu Cách")).statusCode).toBe(400);
  });

  it("huỷ kết bạn → cả hai mất nhau và bên kia nhận FRIEND_REMOVE", async () => {
    const bobClient = await connect(bob);
    expect((await removeFriend(alice.token, bob.id)).statusCode).toBe(204);
    const event = await bobClient.dispatch<{ userId: string }>("FRIEND_REMOVE");
    expect(event.userId).toBe(alice.id);

    // alice còn bạn khác (carol, từ test gửi chéo) nên kiểm đúng "không còn bob"
    // thay vì đếm tổng — test không phụ thuộc thứ tự các test khác.
    for (const [token, other] of [
      [alice.token, bob.username],
      [bob.token, alice.username],
    ] as const) {
      const list = (await listFriends(token)).json<{
        friends: Array<{ user: { username: string } }>;
      }>();
      expect(list.friends.map((row) => row.user.username)).not.toContain(other);
    }
    // Xoá lần hai vẫn 204 (idempotent) nhưng không phát event rác.
    expect((await removeFriend(alice.token, bob.id)).statusCode).toBe(204);
    await bobClient.expectNoDispatch("FRIEND_REMOVE");
  });

  it("chặn cắt luôn quan hệ bạn bè và gửi lời mời cho người đã chặn → 403", async () => {
    // carol và alice đang là bạn; carol chặn alice.
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(carol.token),
    });
    const list = (await listFriends(carol.token)).json<{ friends: unknown[] }>();
    expect(list.friends).toHaveLength(0);

    const denied = await addFriend(alice.token, carol.username);
    expect(denied.statusCode).toBe(403);

    // Bỏ chặn rồi mới thử tiếp các test khác.
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/blocks/${alice.id}`,
      headers: auth(carol.token),
    });
  });
});

describe("quyền riêng tư DM", () => {
  it("mặc định là everyone (không đổi hành vi cũ)", async () => {
    const list = (await listFriends(bob.token)).json<{ dmPrivacy: string }>();
    expect(list.dmPrivacy).toBe("everyone");
    const dm = await openDm(alice.token, bob.id);
    expect(dm.statusCode).toBe(201);
  });

  it("friends: người lạ → 403 kèm lý do, bạn bè → mở được", async () => {
    const patched = await setPrivacy(bob.token, "friends");
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ dmPrivacy: string }>().dmPrivacy).toBe("friends");

    // carol và bob chưa từng là bạn, chưa có DM nào → chặn.
    const denied = await openDm(carol.token, bob.id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { message: string } }>().error.message).toContain("bạn bè");

    // Kết bạn rồi thì mở được.
    // (bob mời carol, carol đồng ý)
    expect((await addFriend(bob.token, carol.username)).statusCode).toBe(201);
    expect((await accept(carol.token, bob.id)).statusCode).toBe(200);
    const allowed = await openDm(carol.token, bob.id);
    expect(allowed.statusCode).toBe(201);
  });

  it("DM đã tồn tại vẫn mở lại được sau khi unfriend (không cắt ngang cuộc đang có)", async () => {
    // bob ↔ carol đang là bạn và đã có DM từ test trên.
    const before = await openDm(bob.token, carol.id);
    expect(before.statusCode).toBe(200); // trả lại kênh cũ

    expect((await removeFriend(carol.token, bob.id)).statusCode).toBe(204);
    const after = await openDm(carol.token, bob.id);
    expect(after.statusCode).toBe(200); // vẫn là kênh cũ, không bị 403
  });

  it("đổi cài đặt sai kiểu → 400; đổi xong phát USER_SETTINGS_UPDATE cho chính mình", async () => {
    expect((await setPrivacy(bob.token, "khong_ai")).statusCode).toBe(400);
    const missing = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/users/@me/settings",
      headers: auth(bob.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const bobClient = await connect(bob);
    const back = await setPrivacy(bob.token, "everyone");
    expect(back.statusCode).toBe(200);
    const event = await bobClient.dispatch<{ dmPrivacy: string }>("USER_SETTINGS_UPDATE");
    expect(event.dmPrivacy).toBe("everyone");
  });
});
