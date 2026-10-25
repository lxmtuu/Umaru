import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
let alice: RegisteredUser;
let bob: RegisteredUser;
let carol: RegisteredUser;
let guildId: string;
let channelId: string;

interface StateRow {
  channelId: string;
  lastReadMessageId: string;
  unread: number;
  mentions: number;
}

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  carol = await registerUser(ctx, "carol");

  guildId = await createGuild(ctx, alice.token);
  channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
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
});

afterAll(async () => {
  await ctx.close();
});

async function readStates(user: RegisteredUser): Promise<StateRow[]> {
  const res = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/users/@me/read-states",
    headers: auth(user.token),
  });
  expect(res.statusCode).toBe(200);
  return res.json<StateRow[]>();
}

async function unreadOf(user: RegisteredUser, channel: string): Promise<number> {
  const states = await readStates(user);
  return states.find((state) => state.channelId === channel)?.unread ?? 0;
}

async function mentionsOf(user: RegisteredUser, channel: string): Promise<number> {
  const states = await readStates(user);
  return states.find((state) => state.channelId === channel)?.mentions ?? 0;
}

function ack(user: RegisteredUser, channel: string, messageId?: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channel}/read`,
    headers: auth(user.token),
    payload: messageId === undefined ? {} : { messageId },
  });
}

describe("read states (badge chưa đọc)", () => {
  it("kênh chưa có mốc đã đọc: mọi tin người khác gửi đều tính là chưa đọc", async () => {
    await sendMessage(ctx, alice.token, channelId, "tin đầu tiên của kênh");
    // DM mới cũng rơi vào trường hợp này — người nhận phải thấy badge.
    expect(await unreadOf(bob, channelId)).toBe(1);
  });

  it("đánh dấu đã đọc rồi có tin mới → unread tăng, tin tự gửi không tính", async () => {
    expect((await ack(bob, channelId)).statusCode).toBe(204);

    await sendMessage(ctx, alice.token, channelId, "tin 1 sau khi bob đọc");
    await sendMessage(ctx, alice.token, channelId, "tin 2 sau khi bob đọc");
    await sendMessage(ctx, bob.token, channelId, "bob tự nói");

    expect(await unreadOf(bob, channelId)).toBe(2);
    // Mốc đã đọc của bob không ảnh hưởng sang người khác
    expect(await unreadOf(alice, channelId)).toBeGreaterThanOrEqual(1);
  });

  it("ack tin cũ hơn không kéo mốc đã đọc về sau", async () => {
    const first = await sendMessage(ctx, alice.token, channelId, "tin A");
    const second = await sendMessage(ctx, alice.token, channelId, "tin B");

    expect((await ack(bob, channelId, second.id)).statusCode).toBe(204);
    expect(await unreadOf(bob, channelId)).toBe(0);

    expect((await ack(bob, channelId, first.id)).statusCode).toBe(204);
    const states = await readStates(bob);
    expect(states.find((state) => state.channelId === channelId)?.lastReadMessageId).toBe(second.id);
    expect(await unreadOf(bob, channelId)).toBe(0);

    await sendMessage(ctx, alice.token, channelId, "tin C");
    expect(await unreadOf(bob, channelId)).toBe(1);
  });

  it("tin nhắn không thuộc kênh, người ngoài và kênh lạ bị từ chối", async () => {
    const other = await sendMessage(ctx, alice.token, channelId, "tin ở kênh này");

    const outsider = await registerUser(ctx, "dave");
    const outsiderStates = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/read-states",
      headers: auth(outsider.token),
    });
    expect(outsiderStates.json<StateRow[]>()).toHaveLength(0);

    const denied = await ack(outsider, channelId);
    expect(denied.statusCode).toBe(404);

    const missing = await ack(bob, "999999999999999999");
    expect(missing.statusCode).toBe(404);

    // Kênh thứ hai trong cùng guild (bob thấy được) nhưng tin thuộc kênh đầu → 400
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "kenh-phu", type: "guild_text" },
    });
    expect(created.statusCode).toBe(201);
    const otherChannelId = created.json<{ id: string }>().id;
    const wrongChannel = await ack(bob, otherChannelId, other.id);
    expect(wrongChannel.statusCode).toBe(400);
  });

  it("DM có read state riêng cho từng người", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: carol.id },
    });
    const dmChannelId = dm.json<{ channel: { id: string } }>().channel.id;

    expect((await ack(carol, dmChannelId)).statusCode).toBe(204);
    await sendMessage(ctx, alice.token, dmChannelId, "DM mới");
    await sendMessage(ctx, alice.token, dmChannelId, "DM mới 2");

    expect(await unreadOf(carol, dmChannelId)).toBe(2);
    expect(await unreadOf(alice, dmChannelId)).toBe(0);
  });

  it("@mention đếm riêng cho từng người, tự nhắc mình không tính", async () => {
    await ack(bob, channelId);
    await ack(carol, channelId);

    await sendMessage(ctx, alice.token, channelId, "@bob bạn xem help này với");

    expect(await mentionsOf(bob, channelId)).toBe(1);
    expect(await mentionsOf(carol, channelId)).toBe(0);
    // Mention cũng là tin chưa đọc
    expect(await unreadOf(bob, channelId)).toBe(1);

    // bob tự nhắc mình → không tăng badge của bob
    await sendMessage(ctx, bob.token, channelId, "@bob note cho mình sau");
    expect(await mentionsOf(bob, channelId)).toBe(1);
  });

  it("sửa tin nhắn cập nhật lại mention; ack xoá badge mention", async () => {
    await ack(bob, channelId);
    await ack(carol, channelId);

    const mentioned = await sendMessage(ctx, alice.token, channelId, "@carol xem PR này");
    expect(await mentionsOf(carol, channelId)).toBe(1);
    expect(await mentionsOf(bob, channelId)).toBe(0);

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${mentioned.id}`,
      headers: auth(alice.token),
      payload: { content: "@bob xem PR này" },
    });
    expect(await mentionsOf(carol, channelId)).toBe(0);
    expect(await mentionsOf(bob, channelId)).toBe(1);

    // ack mặc định (tin mới nhất) xoá sạch mention
    expect((await ack(carol, channelId)).statusCode).toBe(204);
    expect(await mentionsOf(carol, channelId)).toBe(0);
  });

  it("username không tồn tại và phần sau @ không phải username không gây lỗi", async () => {
    const before = await mentionsOf(bob, channelId);
    await sendMessage(ctx, alice.token, channelId, "@khongtontai và mail a@b.com @ ");
    expect(await mentionsOf(bob, channelId)).toBe(before);
  });
});
