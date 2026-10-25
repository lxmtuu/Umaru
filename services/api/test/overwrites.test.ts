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
let everyoneRoleId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  guildId = await createGuild(ctx, alice.token);
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId: generalId },
  });
  const { code } = invite.json<{ code: string }>();
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(bob.token),
  });

  everyoneRoleId = (await listRoles(alice.token))[0]!.id;
});

afterAll(async () => {
  await ctx.close();
});

interface RoleBody {
  id: string;
  name: string;
  position: number;
  isEveryone: boolean;
}

interface OverwriteBody {
  channelId: string;
  targetType: "role" | "member";
  targetId: string;
  targetName: string;
  isEveryone: boolean;
  allow: string;
  deny: string;
}

async function listRoles(token: string): Promise<RoleBody[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: auth(token),
  });
  if (response.statusCode !== 200) throw new Error(`List role lỗi: ${response.body}`);
  return response.json();
}

async function createRole(token: string, payload: Record<string, unknown>): Promise<RoleBody> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: auth(token),
    payload,
  });
  if (response.statusCode !== 201) throw new Error(`Tạo role lỗi: ${response.body}`);
  return response.json();
}

async function createChannel(token: string, name: string): Promise<string> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(token),
    payload: { name, type: "guild_text" },
  });
  if (response.statusCode !== 201) throw new Error(`Tạo kênh lỗi: ${response.body}`);
  return response.json<{ id: string }>().id;
}

function putOverwrite(
  token: string,
  channelId: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/channels/${channelId}/overwrites/${targetType}/${targetId}`,
    headers: auth(token),
    payload,
  });
}

async function listOverwrites(token: string, channelId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/channels/${channelId}/overwrites`,
    headers: auth(token),
  });
  return { statusCode: response.statusCode, body: response.json<OverwriteBody[]>() };
}

async function canRead(token: string, channelId: string): Promise<number> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(token),
  });
  return response.statusCode;
}

async function canSend(token: string, channelId: string): Promise<number> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(token),
    payload: { content: "thử quyền" },
  });
  return response.statusCode;
}

describe("channel permission overwrites", () => {
  it("chỉ người có MANAGE_CHANNELS/MANAGE_ROLES mới xem/sửa; validate đầu vào", async () => {
    expect((await listOverwrites(bob.token, generalId)).statusCode).toBe(403);
    expect(
      (await putOverwrite(bob.token, generalId, "role", everyoneRoleId, {
        allow: "1",
        deny: "0",
      })).statusCode,
    ).toBe(403);

    // targetType lạ / bitfield rác / allow chồng deny / target không tồn tại.
    expect(
      (await putOverwrite(alice.token, generalId, "bogus", everyoneRoleId, { allow: "1" })).statusCode,
    ).toBe(400);
    expect(
      (await putOverwrite(alice.token, generalId, "role", everyoneRoleId, { allow: "abc" })).statusCode,
    ).toBe(400);
    expect(
      (await putOverwrite(alice.token, generalId, "role", everyoneRoleId, {
        allow: "1",
        deny: "1",
      })).statusCode,
    ).toBe(400);
    expect(
      (await putOverwrite(alice.token, generalId, "role", "123", { allow: "1" })).statusCode,
    ).toBe(404);
    expect(
      (await putOverwrite(alice.token, generalId, "member", "123", { deny: "1" })).statusCode,
    ).toBe(404);

    // DM không có role/overwrite.
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const dmId = dm.json<{ channel: { id: string } }>().channel.id;
    expect((await listOverwrites(alice.token, dmId)).statusCode).toBe(404);
  });

  it("@everyone deny VIEW_CHANNEL ẩn kênh; allow cho member kéo lại; deny SEND chặn gửi", async () => {
    const privateId = await createChannel(alice.token, "private");
    expect(await canRead(bob.token, privateId)).toBe(200);

    const denyView = await putOverwrite(alice.token, privateId, "role", everyoneRoleId, {
      allow: "0",
      deny: serializePermissions(Permission.VIEW_CHANNEL),
    });
    expect(denyView.statusCode).toBe(200);
    expect(denyView.json<OverwriteBody>()).toMatchObject({
      targetType: "role",
      targetId: everyoneRoleId,
      targetName: "@everyone",
      isEveryone: true,
      allow: "0",
      deny: serializePermissions(Permission.VIEW_CHANNEL),
    });

    // Member mất quyền xem → 404 và kênh biến khỏi danh sách.
    expect(await canRead(bob.token, privateId)).toBe(404);
    const bobChannels = await listChannels(ctx, bob.token, guildId);
    expect(bobChannels.map((channel) => channel.id)).not.toContain(privateId);
    // Owner/ADMIN bỏ qua overwrite → vẫn thấy.
    expect(await canRead(alice.token, privateId)).toBe(200);

    // Allow riêng cho bob → mở lại đúng kênh đó.
    const allowBob = await putOverwrite(alice.token, privateId, "member", bob.id, {
      allow: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
      deny: "0",
    });
    expect(allowBob.statusCode).toBe(200);
    expect(allowBob.json<OverwriteBody>().targetName).toBe("bob");
    expect(await canRead(bob.token, privateId)).toBe(200);
    expect(await canSend(bob.token, privateId)).toBe(201);

    // @everyone deny SEND_MESSAGES: overwrite member thắng role → bob vẫn gửi được.
    await putOverwrite(alice.token, privateId, "role", everyoneRoleId, {
      allow: "0",
      deny: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
    });
    expect(await canRead(bob.token, privateId)).toBe(200);
    expect(await canSend(bob.token, privateId)).toBe(201);

    // Thu allow của bob (0/0 = xoá dòng) → lại 404.
    const reset = await putOverwrite(alice.token, privateId, "member", bob.id, {
      allow: "0",
      deny: "0",
    });
    expect(reset.statusCode).toBe(204);
    expect(await canRead(bob.token, privateId)).toBe(404);

    // Danh sách overwrite còn đúng 1 dòng (@everyone) kèm deny SEND + VIEW.
    const listed = await listOverwrites(alice.token, privateId);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ targetType: "role", isEveryone: true });

    // Xoá hẳn overwrite @everyone → bob thấy lại kênh.
    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${privateId}/overwrites/role/${everyoneRoleId}`,
      headers: auth(alice.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect(await canRead(bob.token, privateId)).toBe(200);
    expect((await listOverwrites(alice.token, privateId)).body).toHaveLength(0);
  });

  it("overwrite của category kế thừa xuống kênh con; kênh con đè được; đổi category tính lại quyền", async () => {
    const category = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "Team", type: "category" },
    });
    expect(category.statusCode).toBe(201);
    const categoryId = category.json<{ id: string }>().id;

    const child = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "team-chat", type: "guild_text", parentId: categoryId },
    });
    expect(child.statusCode).toBe(201);
    const childId = child.json<{ id: string }>().id;
    expect(await canRead(bob.token, childId)).toBe(200);

    // Deny SEND ở category → kênh con thừa hưởng (đọc được, gửi 403).
    await putOverwrite(alice.token, categoryId, "role", everyoneRoleId, {
      allow: "0",
      deny: serializePermissions(Permission.SEND_MESSAGES),
    });
    expect(await canRead(bob.token, childId)).toBe(200);
    expect(await canSend(bob.token, childId)).toBe(403);

    // Allow riêng ở kênh con thắng deny của category.
    await putOverwrite(alice.token, childId, "member", bob.id, {
      allow: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
      deny: "0",
    });
    expect(await canSend(bob.token, childId)).toBe(201);

    // Đưa kênh ra gốc → category không còn áp; bỏ overwrite riêng thì vẫn gửi được.
    const moved = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${childId}`,
      headers: auth(alice.token),
      payload: { parentId: null },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ categoryId: string | null }>().categoryId).toBeNull();
    expect(await canSend(bob.token, childId)).toBe(201);
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${childId}/overwrites/member/${bob.id}`,
      headers: auth(alice.token),
    });
    expect(await canSend(bob.token, childId)).toBe(201);

    // Đưa trở lại category → deny kế thừa áp lại ngay.
    const movedBack = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${childId}`,
      headers: auth(alice.token),
      payload: { parentId: categoryId },
    });
    expect(movedBack.statusCode).toBe(200);
    expect(movedBack.json<{ categoryId: string }>().categoryId).toBe(categoryId);
    expect(await canSend(bob.token, childId)).toBe(403);

    // Category deny VIEW → kênh con biến mất khỏi danh sách; allow ở kênh mở riêng nó ra.
    await putOverwrite(alice.token, categoryId, "role", everyoneRoleId, {
      allow: "0",
      deny: serializePermissions(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES),
    });
    expect(await canRead(bob.token, childId)).toBe(404);
    expect((await listChannels(ctx, bob.token, guildId)).map((channel) => channel.id)).not.toContain(
      childId,
    );
    await putOverwrite(alice.token, childId, "member", bob.id, {
      allow: serializePermissions(Permission.VIEW_CHANNEL),
      deny: "0",
    });
    expect(await canRead(bob.token, childId)).toBe(200);
    expect((await listChannels(ctx, bob.token, guildId)).map((channel) => channel.id)).toContain(
      childId,
    );

    // Validate PATCH parentId: parent phải là category trong cùng server.
    const textParent = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${childId}`,
      headers: auth(alice.token),
      payload: { parentId: generalId },
    });
    expect(textParent.statusCode).toBe(400);
    const selfParent = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${categoryId}`,
      headers: auth(alice.token),
      payload: { parentId: categoryId },
    });
    expect(selfParent.statusCode).toBe(400);
    const otherGuildId = await createGuild(ctx, alice.token, "Server khác category");
    const otherCategory = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${otherGuildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "Other", type: "category" },
    });
    const crossGuild = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${childId}`,
      headers: auth(alice.token),
      payload: { parentId: otherCategory.json<{ id: string }>().id },
    });
    expect(crossGuild.statusCode).toBe(400);

    // Thành viên thường không di chuyển được kênh.
    const deniedMove = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${childId}`,
      headers: auth(bob.token),
      payload: { parentId: null },
    });
    expect(deniedMove.statusCode).toBe(403);
  });

  it("mask quyền và phân cấp: mod không cho quyền mình không có, không đụng role cao hơn", async () => {
    const channelId = await createChannel(alice.token, "mod-room");
    const chanMod = await createRole(alice.token, {
      name: "ChanMod",
      permissions: serializePermissions(
        Permission.VIEW_CHANNEL |
          Permission.SEND_MESSAGES |
          Permission.READ_HISTORY |
          Permission.MANAGE_CHANNELS,
      ),
    });
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${chanMod.id}`,
      headers: auth(alice.token),
    });

    // Bob có MANAGE_CHANNELS nhưng không có MANAGE_MESSAGES → không được phép allow.
    const escalate = await putOverwrite(bob.token, channelId, "role", everyoneRoleId, {
      allow: serializePermissions(Permission.MANAGE_MESSAGES),
      deny: "0",
    });
    expect(escalate.statusCode).toBe(403);

    // Deny thì luôn được — từ chối không phải leo thang.
    const denyOk = await putOverwrite(bob.token, channelId, "role", everyoneRoleId, {
      allow: "0",
      deny: serializePermissions(Permission.MENTION_EVERYONE),
    });
    expect(denyOk.statusCode).toBe(200);

    // Role cao hơn cấp bob → không sửa được overwrite của nó.
    const senior = await createRole(alice.token, { name: "Senior" });
    const overSenior = await putOverwrite(bob.token, channelId, "role", senior.id, {
      allow: "0",
      deny: serializePermissions(Permission.SEND_MESSAGES),
    });
    expect(overSenior.statusCode).toBe(403);

    // Thành viên có role cao hơn cấp bob cũng không đụng được.
    const seniorMember = await registerUser(ctx, "senioruser");
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
      headers: auth(seniorMember.token),
    });
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${seniorMember.id}/roles/${senior.id}`,
      headers: auth(alice.token),
    });
    const overSeniorMember = await putOverwrite(bob.token, channelId, "member", seniorMember.id, {
      allow: "0",
      deny: serializePermissions(Permission.SEND_MESSAGES),
    });
    expect(overSeniorMember.statusCode).toBe(403);
  });
});
