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

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let generalId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  guildId = await createGuild(ctx, alice.token);
  const channels = await listChannels(ctx, alice.token, guildId);
  generalId = channels[0]!.id;
});

afterAll(async () => {
  await ctx.close();
});

describe("guild & channel", () => {
  it("tạo guild sinh role @everyone và kênh #general, owner thấy được", async () => {
    const guilds = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/guilds",
      headers: auth(alice.token),
    });
    expect(guilds.json<Array<{ id: string; name: string }>>()).toEqual([
      expect.objectContaining({ id: guildId, name: "Umaru Dev" }),
    ]);

    const channels = await listChannels(ctx, alice.token, guildId);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toEqual(expect.objectContaining({ name: "general", type: "guild_text" }));

    const roles = await ctx.pool.query<{ is_everyone: boolean; permissions: string }>(
      "SELECT is_everyone, permissions FROM roles WHERE guild_id = $1",
      [guildId],
    );
    expect(roles.rows).toHaveLength(1);
    expect(roles.rows[0]?.is_everyone).toBe(true);
    // Mặc định có cả CONNECT/SPEAK để kênh thoại dùng được ngay sau khi tạo.
    expect(roles.rows[0]?.permissions).toBe(
      serializePermissions(
        Permission.VIEW_CHANNEL |
          Permission.SEND_MESSAGES |
          Permission.READ_HISTORY |
          Permission.CONNECT |
          Permission.SPEAK,
      ),
    );
  });

  it("người ngoài server không thấy kênh (404, không lộ sự tồn tại)", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(bob.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it("invite cho phép thành viên mới vào server", async () => {
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: generalId },
    });
    expect(invite.statusCode).toBe(201);
    const { code } = invite.json<{ code: string }>();
    expect(code).toMatch(/^[A-Za-z0-9]{6,16}$/);

    const join = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });
    expect(join.statusCode).toBe(200);
    expect(join.json<{ id: string }>().id).toBe(guildId);

    const channels = await listChannels(ctx, bob.token, guildId);
    expect(channels.map((channel) => channel.name)).toContain("general");

    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/code-khong-ton-tai`,
      headers: auth(bob.token),
    });
    expect(again.statusCode).toBe(404);
  });

  it("thành viên thường không tạo được kênh, owner thì được", async () => {
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(bob.token),
      payload: { name: "bi-mat" },
    });
    expect(denied.statusCode).toBe(403);

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "thao-luan", type: "guild_text" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ name: string }>().name).toBe("thao-luan");

    const invalidParent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "con", parentId: generalId },
    });
    expect(invalidParent.statusCode).toBe(400);
  });
});

describe("message", () => {
  it("gửi tin, đọc lại và sắp xếp theo snowflake giảm dần", async () => {
    const first = await sendMessage(ctx, alice.token, generalId, "tin 1");
    const second = await sendMessage(ctx, bob.token, generalId, "tin 2");
    expect(BigInt(second.id)).toBeGreaterThan(BigInt(first.id));

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(bob.token),
    });
    expect(list.statusCode).toBe(200);
    const messages = list.json<Array<{ id: string; content: string; authorId: string }>>();
    expect(messages.map((message) => message.content)).toEqual(["tin 2", "tin 1"]);
    expect(messages[0]!.authorId).toBe(bob.id);
  });

  it("cursor `before` trả trang cũ hơn", async () => {
    const older = await sendMessage(ctx, alice.token, generalId, "tin cũ");
    const newest = await sendMessage(ctx, alice.token, generalId, "tin mới");

    const page = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages?limit=1&before=${newest.id}`,
      headers: auth(alice.token),
    });
    expect(page.statusCode).toBe(200);
    const items = page.json<Array<{ id: string }>>();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(older.id);

    const invalid = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages?before=abc`,
      headers: auth(alice.token),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("chỉ tác giả (hoặc người có MANAGE_MESSAGES) mới sửa/xoá được", async () => {
    const message = await sendMessage(ctx, alice.token, generalId, "nội dung gốc");

    const denied = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(bob.token),
      payload: { content: "bob sửa trộm" },
    });
    expect(denied.statusCode).toBe(403);

    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(alice.token),
      payload: { content: "nội dung đã sửa" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ content: string; editedAt: string | null }>()).toEqual(
      expect.objectContaining({ content: "nội dung đã sửa", editedAt: expect.any(String) }),
    );

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(alice.token),
    });
    expect(deleted.statusCode).toBe(204);

    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(alice.token),
    });
    expect(after.json<Array<{ id: string }>>().map((item) => item.id)).not.toContain(message.id);
  });

  it("tin nhắn rỗng / quá dài bị từ chối", async () => {
    const empty = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(alice.token),
      payload: { content: "" },
    });
    expect(empty.statusCode).toBe(400);

    const tooLong = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(alice.token),
      payload: { content: "a".repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("người ngoài không đọc/gửi được tin trong kênh", async () => {
    const outsider = await registerUser(ctx, "outsider");
    const read = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(outsider.token),
    });
    expect(read.statusCode).toBe(404);

    const write = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/messages`,
      headers: auth(outsider.token),
      payload: { content: "xin chào" },
    });
    expect(write.statusCode).toBe(404);
  });

  it("typing bị throttle 8 giây/kênh", async () => {
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/typing`,
      headers: auth(alice.token),
    });
    expect(first.statusCode).toBe(204);
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${generalId}/typing`,
      headers: auth(alice.token),
    });
    expect(second.statusCode).toBe(429);
    expect(second.json<{ retry_after: number }>().retry_after).toBeGreaterThan(0);
  });
});
