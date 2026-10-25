import { Permission, serializePermissions } from "@umaru/protocol";
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

interface MessageBody {
  id: string;
  channelId: string;
  pinned: boolean;
  content: string;
}

describe("ghim tin nhắn", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let guildId: string;
  let channelId: string;
  let memberRoleId: string;

  const pin = (token: string, messageId: string) =>
    ctx.app.inject({
      method: "PUT",
      url: `/api/v1/messages/${messageId}/pin`,
      headers: auth(token),
    });
  const unpin = (token: string, messageId: string) =>
    ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${messageId}/pin`,
      headers: auth(token),
    });
  const listPins = (token: string, id = channelId) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${id}/pins`,
      headers: auth(token),
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "pin_alice");
    bob = await registerUser(ctx, "pin_bob");
    guildId = await createGuild(ctx, alice.token, "Pin Server");
    channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

    // Bob vào server qua invite (sendMessage mới không tự vào guild).
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

    // Role cho bob, chưa có MANAGE_MESSAGES → dùng để kiểm 403 rồi cấp quyền.
    const role = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/roles`,
      headers: auth(alice.token),
      payload: {
        name: "Pinner",
        permissions: serializePermissions(
          Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY,
        ),
      },
    });
    memberRoleId = role.json<{ id: string }>().id;
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${memberRoleId}`,
      headers: auth(alice.token),
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("kênh mới chưa có tin ghim", async () => {
    const response = await listPins(alice.token);
    expect(response.statusCode).toBe(200);
    expect(response.json<MessageBody[]>()).toEqual([]);
  });

  it("owner ghim được: trả pinned=true và tin xuất hiện trong danh sách ghim", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "tin quan trọng");
    const response = await pin(alice.token, message.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<MessageBody>().pinned).toBe(true);

    const list = await listPins(alice.token);
    expect(list.statusCode).toBe(200);
    const pins = list.json<MessageBody[]>();
    expect(pins.map((item) => item.id)).toContain(message.id);
    expect(pins[0]).toMatchObject({ id: message.id, pinned: true, content: "tin quan trọng" });
  });

  it("danh sách tin thường cũng mang cờ pinned", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    const messages = response.json<MessageBody[]>();
    expect(messages.filter((message) => message.pinned)).toHaveLength(1);
  });

  it("thành viên không có MANAGE_MESSAGES → 403 khi ghim tin người khác", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "của alice");
    const response = await pin(bob.token, message.id);
    expect(response.statusCode).toBe(403);
    // Không được đổi trạng thái.
    const list = await listPins(alice.token);
    expect(list.json<MessageBody[]>().map((item) => item.id)).not.toContain(message.id);
  });

  it("cấp MANAGE_MESSAGES là ghim được (quyền tính lại ngay)", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "bob ghim được");
    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${memberRoleId}`,
      headers: auth(alice.token),
      payload: {
        permissions: serializePermissions(
          Permission.VIEW_CHANNEL |
            Permission.SEND_MESSAGES |
            Permission.READ_HISTORY |
            Permission.MANAGE_MESSAGES,
        ),
      },
    });
    expect(patched.statusCode).toBe(200);

    const response = await pin(bob.token, message.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<MessageBody>().pinned).toBe(true);
  });

  it("ghim lại tin đã ghim là idempotent (200, không nhân đôi)", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "ghim hai lần");
    expect((await pin(alice.token, message.id)).statusCode).toBe(200);
    expect((await pin(alice.token, message.id)).statusCode).toBe(200);

    const pins = (await listPins(alice.token)).json<MessageBody[]>();
    expect(pins.filter((item) => item.id === message.id)).toHaveLength(1);
  });

  it("bỏ ghim: pinned=false và rời danh sách ghim", async () => {
    const message = await sendMessage(ctx, alice.token, channelId, "bỏ ghim");
    await pin(alice.token, message.id);
    const response = await unpin(alice.token, message.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<MessageBody>().pinned).toBe(false);

    const pins = (await listPins(alice.token)).json<MessageBody[]>();
    expect(pins.map((item) => item.id)).not.toContain(message.id);
    // Bỏ ghim lần nữa vẫn 200 (idempotent).
    expect((await unpin(alice.token, message.id)).statusCode).toBe(200);
  });

  it("không ghim được tin không tồn tại / id rác", async () => {
    expect((await pin(alice.token, "999999999999999999")).statusCode).toBe(404);
    expect((await pin(alice.token, "abc")).statusCode).toBe(400);
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/channels/abc/pins",
      headers: auth(alice.token),
    });
    expect(list.statusCode).toBe(400);
  });

  it("người ngoài server không thấy và không ghim được", async () => {
    const outsider = await registerUser(ctx, "pin_outsider");
    const message = await sendMessage(ctx, alice.token, channelId, "riêng tư");
    // Không có VIEW_CHANNEL → 404 (không lộ sự tồn tại).
    expect((await listPins(outsider.token)).statusCode).toBe(404);
    expect((await pin(outsider.token, message.id)).statusCode).toBe(404);
    expect((await unpin(outsider.token, message.id)).statusCode).toBe(404);
  });

  it("chưa đăng nhập → 401", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/pins`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("giới hạn 50 tin ghim mỗi kênh", async () => {
    // Kênh riêng để không phụ thuộc số tin đã ghim ở trên.
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "pin-limit", type: "guild_text" },
    });
    const limitChannelId = created.json<{ id: string }>().id;

    const ids: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const message = await sendMessage(ctx, alice.token, limitChannelId, `tin ${index}`);
      ids.push(message.id);
    }
    for (const id of ids) {
      expect((await pin(alice.token, id)).statusCode).toBe(200);
    }

    const extra = await sendMessage(ctx, alice.token, limitChannelId, "tin thứ 51");
    const response = await pin(alice.token, extra.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("50");

    // Bỏ một ghim là có chỗ cho tin tiếp theo.
    await unpin(alice.token, ids[0]!);
    expect((await pin(alice.token, extra.id)).statusCode).toBe(200);
  });

  it("DM: người trong cuộc ghim được tin của nhau (không cần MANAGE_MESSAGES)", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const dmChannelId = dm.json<{ channel: { id: string } }>().channel.id;
    const message = await sendMessage(ctx, bob.token, dmChannelId, "hẹn 8h nhé");

    const response = await pin(alice.token, message.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<MessageBody>().pinned).toBe(true);

    const pins = await listPins(bob.token, dmChannelId);
    expect(pins.json<MessageBody[]>().map((item) => item.id)).toEqual([message.id]);
  });

  it("DM bị chặn: danh sách ghim rỗng và không ghim được nữa", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const dmChannelId = dm.json<{ channel: { id: string } }>().channel.id;
    const first = await sendMessage(ctx, alice.token, dmChannelId, "trước khi chặn");
    expect((await pin(alice.token, first.id)).statusCode).toBe(200);

    const blocked = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${bob.id}`,
      headers: auth(alice.token),
    });
    expect(blocked.statusCode).toBeLessThan(300);

    // Lịch sử ẩn ⇒ ghim cũng ẩn, và không ghim thêm được.
    const hidden = await listPins(alice.token, dmChannelId);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json<MessageBody[]>()).toEqual([]);

    expect((await pin(alice.token, first.id)).statusCode).toBe(403);
  });
});
