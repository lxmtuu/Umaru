import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPORT_REASONS } from "@umaru/protocol";
import {
  createTestContext,
  createGuild,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let carol: RegisteredUser;
let guildId: string;
let generalId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  carol = await registerUser(ctx, "carol");
  guildId = await createGuild(ctx, alice.token);
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  // Bob/carol phải là thành viên server mới gửi được tin trong kênh chung.
  for (const user of [bob, carol]) await joinGuild(user);
});

/** Cho một user vừa đăng ký vào server test (dùng lại invite của alice). */
async function joinGuild(user: RegisteredUser): Promise<void> {
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId: generalId },
  });
  const { code } = invite.json<{ code: string }>();
  const joined = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(user.token),
  });
  expect(joined.statusCode).toBeLessThan(300);
}

afterAll(async () => {
  await ctx.close();
});

async function openDm(from: RegisteredUser, to: RegisteredUser): Promise<string> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/users/@me/channels",
    headers: auth(from.token),
    payload: { recipientId: to.id },
  });
  expect(response.statusCode).toBeLessThan(300);
  return response.json<{ channel: { id: string } }>().channel.id;
}

const block = (by: RegisteredUser, target: RegisteredUser) =>
  ctx.app.inject({
    method: "PUT",
    url: `/api/v1/users/@me/blocks/${target.id}`,
    headers: auth(by.token),
  });

const unblock = (by: RegisteredUser, target: RegisteredUser) =>
  ctx.app.inject({
    method: "DELETE",
    url: `/api/v1/users/@me/blocks/${target.id}`,
    headers: auth(by.token),
  });

async function dmBetween(a: RegisteredUser, b: RegisteredUser): Promise<string[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/users/@me/channels",
    headers: auth(a.token),
  });
  expect(response.statusCode).toBe(200);
  return response
    .json<Array<{ channel: { id: string }; recipient: { userId: string } }>>()
    .filter((dm) => dm.recipient.userId === b.id)
    .map((dm) => dm.channel.id);
}

describe("chặn người dùng", () => {
  it("chặn là idempotent, danh sách block trả đúng người, không lộ email", async () => {
    expect((await block(alice, bob)).statusCode).toBe(204);
    expect((await block(alice, bob)).statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/blocks",
      headers: auth(alice.token),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json<Array<{ userId: string; displayName: string; email?: string }>>();
    expect(items.map((item) => item.userId)).toContain(bob.id);
    expect(items[0]?.email).toBeUndefined();

    // Bob không thấy mình bị chặn trong danh sách của chính mình.
    const bobList = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/blocks",
      headers: auth(bob.token),
    });
    expect(bobList.json<unknown[]>()).toHaveLength(0);

    expect((await unblock(alice, bob)).statusCode).toBe(204);
  });

  it("tự chặn mình → 400; người không tồn tại → 404", async () => {
    expect((await block(alice, alice)).statusCode).toBe(400);
    const ghost = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/blocks/999999999999999999",
      headers: auth(alice.token),
    });
    expect(ghost.statusCode).toBe(404);
  });

  it("chặn cắt cả hai chiều: không tạo được DM, không nhắn được, DM cũ biến khỏi danh sách", async () => {
    const channelId = await openDm(alice, bob);
    await sendMessage(ctx, alice.token, channelId, "tin trước khi chặn");
    expect(await dmBetween(alice, bob)).toContain(channelId);

    expect((await block(bob, alice)).statusCode).toBe(204);

    // Người chặn cũng không mở lại DM được, người bị chặn cũng vậy.
    for (const [from, to] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const reopen = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/users/@me/channels",
        headers: auth(from.token),
        payload: { recipientId: to.id },
      });
      expect(reopen.statusCode).toBe(403);
      expect(reopen.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    }

    // Gửi vào DM cũ cũng bị chặn.
    for (const sender of [alice, bob]) {
      const send = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/channels/${channelId}/messages`,
        headers: auth(sender.token),
        payload: { content: "cố gửi sau khi chặn" },
      });
      expect(send.statusCode).toBe(403);
    }

    // Lịch sử DM cũ không còn đọc được (cả hai phía), và DM biến khỏi danh sách.
    for (const viewer of [alice, bob]) {
      const history = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/messages`,
        headers: auth(viewer.token),
      });
      expect(history.statusCode).toBe(200);
      expect(history.json<unknown[]>()).toHaveLength(0);
      expect(await dmBetween(viewer, viewer === alice ? bob : alice)).not.toContain(channelId);
    }

    expect((await unblock(bob, alice)).statusCode).toBe(204);
    // Bỏ chặn thì DM cũ hiện lại và nhắn tiếp được.
    expect(await dmBetween(alice, bob)).toContain(channelId);
    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
      payload: { content: "sau khi bỏ chặn" },
    });
    expect(again.statusCode).toBe(201);
  });

  it("mention và tìm kiếm bỏ qua tin của người đã chặn nhau", async () => {
    const victim = await registerUser(ctx, "victim");
    const spammer = await registerUser(ctx, "spammer");
    await joinGuild(victim);
    await joinGuild(spammer);
    await sendMessage(ctx, spammer.token, generalId, `chào @victim lần một spam-marker`);
    await sendMessage(ctx, victim.token, generalId, "phản hồi của victim spam-marker");

    const beforeMentions = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/mentions",
      headers: auth(victim.token),
    });
    expect(
      beforeMentions
        .json<Array<{ message: { content: string } }>>()
        .some((item) => item.message.content.includes("spam-marker")),
    ).toBe(true);

    expect((await block(victim, spammer)).statusCode).toBe(204);

    const afterMentions = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/mentions",
      headers: auth(victim.token),
    });
    expect(
      afterMentions
        .json<Array<{ message: { content: string } }>>()
        .some((item) => item.message.content.includes("spam-marker")),
    ).toBe(false);

    const search = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages/search?q=spam-marker`,
      headers: auth(victim.token),
    });
    expect(search.statusCode).toBe(200);
    const hits = search.json<Array<{ message: { content: string }; author: { userId: string } }>>();
    expect(hits.every((hit) => hit.author.userId !== spammer.id)).toBe(true);

    // Người khác (không chặn ai) vẫn thấy tin của spammer trong kênh server.
    const carolSearch = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages/search?q=spam-marker`,
      headers: auth(carol.token),
    });
    expect(
      carolSearch.json<Array<{ author: { userId: string } }>>().length,
    ).toBeGreaterThanOrEqual(1);

    await unblock(victim, spammer);
  });
});

describe("báo cáo vi phạm", () => {
  const report = (by: RegisteredUser, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(by.token),
      payload,
    });

  it("báo cáo một tin: 201, lưu snapshot nội dung + kênh + người bị báo cáo", async () => {
    const message = await sendMessage(ctx, bob.token, generalId, "nội dung bị báo cáo");
    const response = await report(carol, { messageId: message.id, reason: "spam" });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; status: string; createdAt: string }>();
    expect(body.status).toBe("open");
    expect(Number(body.id)).toBeGreaterThan(0);

    const row = await ctx.pool.query<{
      target_user_id: string;
      channel_id: string;
      guild_id: string;
      snapshot_content: string;
      reason: string;
      status: string;
    }>("SELECT * FROM reports WHERE id = $1", [body.id]);
    expect(row.rows[0]?.target_user_id).toBe(bob.id);
    expect(row.rows[0]?.channel_id).toBe(generalId);
    expect(row.rows[0]?.guild_id).toBe(guildId);
    expect(row.rows[0]?.snapshot_content).toBe("nội dung bị báo cáo");
    expect(row.rows[0]?.reason).toBe("spam");
  });

  it("snapshot giữ nguyên nội dung kể cả khi tin bị xoá sau đó", async () => {
    const message = await sendMessage(ctx, bob.token, generalId, "tin sẽ bị xoá ngay");
    const created = await report(carol, { messageId: message.id, reason: "harassment" });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(bob.token),
    });
    expect(del.statusCode).toBe(204);

    const row = await ctx.pool.query<{ snapshot_content: string }>(
      "SELECT snapshot_content FROM reports WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.snapshot_content).toBe("tin sẽ bị xoá ngay");
  });

  it("báo cáo người kèm mô tả; thiếu lý do hợp lệ → 400", async () => {
    const ok = await report(alice, {
      userId: bob.id,
      reason: "impersonation",
      details: "Giả làm admin server",
    });
    expect(ok.statusCode).toBe(201);

    expect((await report(alice, { userId: bob.id, reason: "bịa-ra" })).statusCode).toBe(400);
    expect((await report(alice, { userId: bob.id })).statusCode).toBe(400);
  });

  it("đúng một trong messageId/userId: gửi cả hai hoặc không gửi gì → 400", async () => {
    expect((await report(alice, { reason: "spam" })).statusCode).toBe(400);
    const message = await sendMessage(ctx, bob.token, generalId, "tin để test hai tham số");
    const both = await report(alice, {
      messageId: message.id,
      userId: bob.id,
      reason: "spam",
    });
    expect(both.statusCode).toBe(400);
  });

  it("tự báo cáo mình → 400; tin/kênh không xem được → 404; người lạ → 404", async () => {
    expect((await report(alice, { userId: alice.id, reason: "other" })).statusCode).toBe(400);

    const ghostUser = await report(alice, {
      userId: "999999999999999999",
      reason: "other",
    });
    expect(ghostUser.statusCode).toBe(404);

    const ghostMessage = await report(alice, {
      messageId: "999999999999999999",
      reason: "other",
    });
    expect(ghostMessage.statusCode).toBe(404);

    // Kênh riêng: outsider báo cáo tin trong đó phải 404, không lộ nội dung.
    const outsider = await registerUser(ctx, "outsider");
    const secret = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "riêng-tư", type: "guild_text" },
    });
    const secretId = secret.json<{ id: string }>().id;
    const hidden = await sendMessage(ctx, alice.token, secretId, "chỉ thành viên mới thấy");
    const deniedMessage = await report(outsider, { messageId: hidden.id, reason: "spam" });
    expect(deniedMessage.statusCode).toBe(404);
  });

  it("giới hạn 20 báo cáo/giờ → 403 khi vượt", async () => {
    const troll = await registerUser(ctx, "troll");
    // 20 báo cáo đầu trong giờ phải lọt (bao gồm các báo cáo của test trước đó
    // là của user khác, nên đếm riêng cho troll).
    for (let index = 0; index < 20; index += 1) {
      const response = await report(troll, { userId: bob.id, reason: "spam" });
      expect(response.statusCode).toBe(201);
    }
    const blocked = await report(troll, { userId: bob.id, reason: "spam" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { message: string } }>().error.message).toContain("20");
  });

  it("chưa đăng nhập → 401", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      payload: { userId: bob.id, reason: "spam" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("danh sách lý do của protocol khớp bảng CHECK trong DB", async () => {
    // Nếu thêm lý do mới mà quên migration, insert sẽ nổ constraint — test này
    // gửi thử từng lý do để chắc chắn chạy được.
    const probe = await registerUser(ctx, "probe");
    for (const reason of REPORT_REASONS) {
      const response = await report(probe, { userId: bob.id, reason });
      expect(response.statusCode, `lý do ${reason}`).toBe(201);
    }
    await ctx.pool.query("DELETE FROM reports WHERE reporter_id = $1", [probe.id]);
  });
});
