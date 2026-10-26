import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeEmoji } from "../src/reactions.js";
import type { AddressInfo } from "node:net";
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
 * Reaction trên tin nhắn.
 *
 * Điều đáng kiểm nhất không phải "thả được không" mà là **`me` tính theo người
 * xem**: hai client nhận cùng một tin nhưng cờ `me` phải khác nhau, vì đó là
 * nguồn gốc của lỗi "bấm vào chip của mình hoá ra là thả thêm lần nữa".
 */

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "react_alice");
  bob = await registerUser(ctx, "react_bob");
  guildId = await createGuild(ctx, alice.token, "Reaction Server");
  channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

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
  await ctx.close();
});

function react(token: string, messageId: string, emoji: string, add: boolean) {
  return ctx.app.inject({
    method: add ? "PUT" : "DELETE",
    url: `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    headers: auth(token),
  });
}

interface ReactionsBody {
  reactions: Array<{ emoji: string; count: number; me: boolean }>;
}

describe("reaction: cơ bản", () => {
  it("thả emoji → 200, đếm 1, `me: true` cho người vừa thả", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "thả tim");
    const response = await react(alice.token, message.id, "❤️", true);
    expect(response.statusCode).toBe(200);
    expect(response.json<ReactionsBody>().reactions).toEqual([
      { emoji: "❤️", count: 1, me: true },
    ]);
  });

  it("idempotent: thả cùng emoji hai lần vẫn một dòng, count vẫn 1", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "thả hai lần");
    await react(alice.token, message.id, "👍", true);
    const again = await react(alice.token, message.id, "👍", true);
    expect(again.statusCode).toBe(200);
    expect(again.json<ReactionsBody>().reactions).toEqual([
      { emoji: "👍", count: 1, me: true },
    ]);
  });

  it("bỏ reaction chưa từng thả vẫn 200 (không lỗi)", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "bỏ cái chưa thả");
    const removed = await react(alice.token, message.id, "🎉", false);
    expect(removed.statusCode).toBe(200);
    expect(removed.json<ReactionsBody>().reactions).toEqual([]);
  });

  it("hai người thả cùng emoji → count 2, `me` tính riêng cho từng người", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "cùng thả");
    await react(alice.token, message.id, "🔥", true);
    const bobView = await react(bob.token, message.id, "🔥", true);
    expect(bobView.json<ReactionsBody>().reactions).toEqual([
      { emoji: "🔥", count: 2, me: true },
    ]);

    // Cùng một tin, nhưng góc nhìn của Alice: cô ấy cũng đã thả → vẫn `me: true`.
    const aliceView = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    const found = aliceView
      .json<Array<{ id: string; reactions: Array<{ emoji: string; count: number; me: boolean }> }>>()
      .find((row) => row.id === message.id);
    expect(found?.reactions).toEqual([{ emoji: "🔥", count: 2, me: true }]);

    // Bob bỏ → Alice thấy còn 1 và `me: true` (vẫn là mình), Bob thấy `me: false`.
    const afterBob = await react(bob.token, message.id, "🔥", false);
    expect(afterBob.json<ReactionsBody>().reactions).toEqual([
      { emoji: "🔥", count: 1, me: false },
    ]);
    const aliceAfter = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    const seen = aliceAfter
      .json<Array<{ id: string; reactions: Array<{ emoji: string; count: number; me: boolean }> }>>()
      .find((row) => row.id === message.id);
    expect(seen?.reactions).toEqual([{ emoji: "🔥", count: 1, me: true }]);
  });

  it("nhiều emoji trên một tin: xếp theo lần thả đầu tiên", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "ba emoji");
    await react(alice.token, message.id, "😂", true);
    await react(alice.token, message.id, "👀", true);
    const last = await react(alice.token, message.id, "🎉", true);
    expect(last.json<ReactionsBody>().reactions.map((row) => row.emoji)).toEqual([
      "😂",
      "👀",
      "🎉",
    ]);
  });

  it("emoji dạng emoji gia đình (nhiều codepoint) đi qua URL được", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "emoji phức tạp");
    const emoji = "👨‍👩‍👧‍👦";
    const response = await react(alice.token, message.id, emoji, true);
    expect(response.statusCode).toBe(200);
    expect(response.json<ReactionsBody>().reactions).toEqual([{ emoji, count: 1, me: true }]);
  });

  it("xoá tin → reaction biến mất khỏi DB (CASCADE)", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "sẽ xoá");
    await react(alice.token, message.id, "👍", true);
    const before = await ctx.pool.query(
      "SELECT count(*)::int AS total FROM message_reactions WHERE message_id = $1",
      [message.id],
    );
    expect(before.rows[0].total).toBe(1);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(alice.token),
    });
    const after = await ctx.pool.query(
      "SELECT count(*)::int AS total FROM message_reactions WHERE message_id = $1",
      [message.id],
    );
    expect(after.rows[0].total).toBe(0);
  });
});

describe("reaction: kiểm tra đầu vào và quyền", () => {
  it("emoji rỗng hoặc có khoảng trắng → 400", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "emoji rác");
    // `%20` giải mã thành dấu cách; `%00` bị loại vì là ký tự điều khiển.
    const spaced = await react(alice.token, message.id, " ", true);
    expect(spaced.statusCode).toBe(400);
    const long = await react(alice.token, message.id, "x".repeat(33), true);
    expect(long.statusCode).toBe(400);
  });

  it("người ngoài server → không thả được (404 vì không đọc được kênh)", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "tin riêng của server");
    const outsider = await registerUser(ctx, "react_outsider");
    const response = await react(outsider.token, message.id, "👍", true);
    // `loadChannelContext` ném 404 chứ không 403: không lộ sự tồn tại của kênh.
    expect(response.statusCode).toBe(404);
  });

  it("tin không tồn tại → 404", async () => {
    const response = await react(alice.token, "240329223191920640", "👍", true);
    expect(response.statusCode).toBe(404);
  });

  it(`tối đa 20 emoji khác nhau trên một tin`, async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "nhồi emoji");
    const pool20 = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙", "😚", "🙂", "🤗"];
    expect(pool20).toHaveLength(20);
    for (const emoji of pool20) {
      const response = await react(alice.token, message.id, emoji, true);
      expect(response.statusCode).toBe(200);
    }
    const extra = await react(alice.token, message.id, "🥳", true);
    expect(extra.statusCode).toBe(400);
    expect(extra.json<{ error: { message: string } }>().error.message).toContain("20");

    // Thả lại emoji đã có **không** bị chặn — người dùng không tự khoá mình.
    const repeat = await react(alice.token, message.id, "😀", true);
    expect(repeat.statusCode).toBe(200);
  });
});

describe("normalizeEmoji", () => {
  it("cắt khoảng trắng hai đầu", () => {
    expect(normalizeEmoji("  👍  ")).toBe("👍");
  });

  it("chặn rỗng / chỉ khoảng trắng / ký tự điều khiển", () => {
    expect(() => normalizeEmoji("")).toThrow();
    expect(() => normalizeEmoji("   ")).toThrow();
    expect(() => normalizeEmoji("👍\u0000")).toThrow();
    expect(() => normalizeEmoji("a b")).toThrow();
  });

  it("đếm theo codepoint: emoji gia đình nhiều codepoint vẫn qua", () => {
    // 7 codepoint — nếu đếm theo UTF-16 sẽ thành 11, vẫn dưới trần, nhưng test
    // này khoá việc cắt chuỗi không làm vỡ surrogate pair.
    expect(normalizeEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(() => normalizeEmoji("a".repeat(32))).not.toThrow();
    expect(() => normalizeEmoji("a".repeat(33))).toThrow();
  });
});

describe("MESSAGE_REACTION_UPDATE (gateway)", () => {
  let wsUrl: string;
  const clients: GatewayTestClient[] = [];

  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;
  });

  afterAll(() => {
    for (const client of clients) client.close();
  });

  async function connect(user: RegisteredUser): Promise<GatewayTestClient> {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: 2, d: { token: user.token } });
    await client.next((frame) => frame.op === 0 && frame.t === "READY");
    return client;
  }

  interface ReactionEvent {
    messageId: string;
    channelId: string;
    emoji: string;
    count: number;
    userId: string;
    added: boolean;
  }

  it("người khác thả reaction → client đang mở kênh nhận delta ngay", async () => {
    const bobClient = await connect(bob);
    const message = await sendMessage(ctx, alice.token, channelId, "realtime reaction");

    await react(alice.token, message.id, "🔥", true);
    const event = await bobClient.dispatch<ReactionEvent>("MESSAGE_REACTION_UPDATE");
    expect(event).toEqual({
      messageId: message.id,
      channelId,
      emoji: "🔥",
      count: 1,
      userId: alice.id,
      added: true,
    });

    await react(alice.token, message.id, "🔥", false);
    const removed = await bobClient.dispatch<ReactionEvent>("MESSAGE_REACTION_UPDATE");
    expect(removed.count).toBe(0);
    expect(removed.added).toBe(false);
  });

  it("thả lặp cùng emoji không phát event trùng", async () => {
    const bobClient = await connect(bob);
    const message = await sendMessage(ctx, alice.token, channelId, "thả lặp realtime");

    await react(alice.token, message.id, "👍", true);
    await bobClient.dispatch<ReactionEvent>("MESSAGE_REACTION_UPDATE");
    await react(alice.token, message.id, "👍", true);

    // Frame kế tiếp phải là của emoji khác, chứng minh lần lặp không phát gì.
    await react(alice.token, message.id, "🎉", true);
    const next = await bobClient.next(
      (frame) => frame.op === 0 && frame.t === "MESSAGE_REACTION_UPDATE",
    );
    expect((next.d as ReactionEvent).emoji).toBe("🎉");
  });
});
