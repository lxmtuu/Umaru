import {
  ALL_PERMISSIONS,
  Permission,
  serializePermissions,
} from "@umaru/protocol";
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
/** Role "Mod" (có MANAGE_MESSAGES) tạo trong test thứ 2 — dùng lại ở test phân cấp. */
let modId: string;

interface RoleBody {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  isEveryone: boolean;
}

/**
 * Quyền `@everyone` mặc định khi tạo server — có `CONNECT`/`SPEAK` để kênh thoại
 * dùng được ngay (xem `DEFAULT_EVERYONE_PERMISSIONS` ở guilds/routes.ts).
 */
const DEFAULT_EVERYONE =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_HISTORY |
  Permission.CONNECT |
  Permission.SPEAK;

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

  everyoneRoleId = (await listRoles(alice.token, guildId))[0]!.id;
});

afterAll(async () => {
  await ctx.close();
});

async function listRoles(token: string, targetGuildId: string): Promise<RoleBody[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/guilds/${targetGuildId}/roles`,
    headers: auth(token),
  });
  if (response.statusCode !== 200) throw new Error(`List role lỗi: ${response.body}`);
  return response.json();
}

async function createRole(
  token: string,
  targetGuildId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: RoleBody & { error?: { code: string } } }> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${targetGuildId}/roles`,
    headers: auth(token),
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

function errorCode(body: { error?: { code: string } }): string {
  if (body.error === undefined) throw new Error("Response không chứa error");
  return body.error.code;
}

describe("roles API", () => {
  it("GET roles: @everyone luôn có; thiếu MANAGE_ROLES thì không tạo được", async () => {
    const ownerList = await listRoles(alice.token, guildId);
    expect(ownerList).toHaveLength(1);
    expect(ownerList[0]).toMatchObject({
      id: everyoneRoleId,
      name: "@everyone",
      isEveryone: true,
      position: 0,
      permissions: serializePermissions(DEFAULT_EVERYONE),
    });

    // Thành viên thường xem được (membership là đủ) nhưng không tạo được.
    const memberList = await listRoles(bob.token, guildId);
    expect(memberList).toHaveLength(1);

    const denied = await createRole(bob.token, guildId, { name: "Mod" });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied.body)).toBe("FORBIDDEN");
  });

  it("tạo role → gán → quyền thật có hiệu lực → thu là mất quyền", async () => {
    const created = await createRole(alice.token, guildId, {
      name: "Mod",
      color: 0xff0000,
      permissions: serializePermissions(
        Permission.VIEW_CHANNEL |
          Permission.SEND_MESSAGES |
          Permission.READ_HISTORY |
          Permission.MANAGE_MESSAGES,
      ),
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      name: "Mod",
      color: 0xff0000,
      position: 1, // @everyone = 0, owner tạo lên trên cùng
      isEveryone: false,
    });
    modId = created.body.id;

    // Validate đầu vào.
    expect((await createRole(alice.token, guildId, { name: "  " })).statusCode).toBe(400);
    expect(
      (await createRole(alice.token, guildId, { name: "X", color: 99_999_999 })).statusCode,
    ).toBe(400);
    expect(
      (await createRole(alice.token, guildId, { name: "X", permissions: "abc" })).statusCode,
    ).toBe(400);

    // Bob chưa có role → không gán được, và không xoá được tin của alice.
    const selfAssignDenied = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${modId}`,
      headers: auth(bob.token),
    });
    expect(selfAssignDenied.statusCode).toBe(403);

    const target = await sendMessage(ctx, alice.token, generalId, "cần mod dọn cái này");
    const deniedDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${target.id}`,
      headers: auth(bob.token),
    });
    expect(deniedDelete.statusCode).toBe(403);

    // Owner gán Mod cho bob → bob xoá được tin của người khác NGAY.
    const assigned = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${modId}`,
      headers: auth(alice.token),
    });
    expect(assigned.statusCode).toBe(204);

    const allowedDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${target.id}`,
      headers: auth(bob.token),
    });
    expect(allowedDelete.statusCode).toBe(204);

    // Thu role → quyền biến mất.
    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${modId}`,
      headers: auth(alice.token),
    });
    expect(revoked.statusCode).toBe(204);

    const nextTarget = await sendMessage(ctx, alice.token, generalId, "tin thứ hai");
    const deniedAgain = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${nextTarget.id}`,
      headers: auth(bob.token),
    });
    expect(deniedAgain.statusCode).toBe(403);
  });

  it("phân cấp: không đụng role cao hơn; không cấp/giao quyền ngoài tầm", async () => {
    // ModCap cho bob MANAGE_ROLES → giờ bob mới tự thao tác role được.
    const cap = await createRole(alice.token, guildId, {
      name: "ModCap",
      permissions: serializePermissions(
        Permission.VIEW_CHANNEL |
          Permission.SEND_MESSAGES |
          Permission.READ_HISTORY |
          Permission.MANAGE_ROLES,
      ),
    });
    expect(cap.statusCode).toBe(201);
    const capId = cap.body.id;
    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${capId}`,
      headers: auth(alice.token),
    });
    // bob cao nhất = position 2 (Mod = 1 vẫn tồn tại từ test trước).

    // Leo thang: có MANAGE_ROLES nhưng không thể tạo role ADMIN.
    const escalate = await createRole(bob.token, guildId, {
      name: "Thăng cấp",
      permissions: serializePermissions(ALL_PERMISSIONS),
    });
    expect(escalate.statusCode).toBe(403);
    expect(errorCode(escalate.body)).toBe("FORBIDDEN");

    // Tạo role trong tầm quyền của mình thì được — ngang cấp mình, không vượt trên.
    const own = await createRole(bob.token, guildId, {
      name: "Đồng cấp",
      permissions: serializePermissions(Permission.MANAGE_ROLES),
    });
    expect(own.statusCode).toBe(201);
    expect(own.body.position).toBe(2);
    const ownId = own.body.id;

    // Owner tạo role cao hơn bob.
    const senior = await createRole(alice.token, guildId, { name: "Senior" });
    expect(senior.statusCode).toBe(201);
    expect(senior.body.position).toBe(3);
    const seniorId = senior.body.id;

    // Bob không sửa / không xoá / không gán được role cao hơn cấp mình.
    const renameSenior = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${seniorId}`,
      headers: auth(bob.token),
      payload: { name: "Hack" },
    });
    expect(renameSenior.statusCode).toBe(403);
    const deleteSenior = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guildId}/roles/${seniorId}`,
      headers: auth(bob.token),
    });
    expect(deleteSenior.statusCode).toBe(403);
    const assignSenior = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${seniorId}`,
      headers: auth(bob.token),
    });
    expect(assignSenior.statusCode).toBe(403);

    // Sửa role ngang cấp mình thì được.
    const renameOwn = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${ownId}`,
      headers: auth(bob.token),
      payload: { name: "Đồng cấp 2" },
    });
    expect(renameOwn.statusCode).toBe(200);
    expect(renameOwn.json<{ name: string }>().name).toBe("Đồng cấp 2");

    // Mask: bob không có KICK_MEMBERS → không thể bỏ KICK vào role khác.
    const grantKick = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${capId}`,
      headers: auth(bob.token),
      payload: { permissions: serializePermissions(Permission.KICK_MEMBERS) },
    });
    expect(grantKick.statusCode).toBe(403);

    // Mask khi GÁN: Mod chứa MANAGE_MESSAGES mà bob không có → không tự gán được,
    // dù Mod nằm dưới cấp của bob (position 1 < 2).
    const assignMod = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${modId}`,
      headers: auth(bob.token),
    });
    expect(assignMod.statusCode).toBe(403);

    // Role của server khác không đụng tới được.
    const otherGuildId = await createGuild(ctx, alice.token, "Server khác");
    const crossGuild = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${otherGuildId}/roles/${capId}`,
      headers: auth(alice.token),
      payload: { name: "Hack" },
    });
    expect(crossGuild.statusCode).toBe(404);
  });

  it("@everyone: không xoá/gán; sửa permissions có hiệu lực thật", async () => {
    const deleteEveryone = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/guilds/${guildId}/roles/${everyoneRoleId}`,
      headers: auth(alice.token),
    });
    expect(deleteEveryone.statusCode).toBe(400);

    const assignEveryone = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${everyoneRoleId}`,
      headers: auth(alice.token),
    });
    expect(assignEveryone.statusCode).toBe(400);

    // Bob có MANAGE_ROLES (ModCap) và @everyone nằm dưới cấp anh ta,
    // nhưng mask chặn: không thể nhét MANAGE_MESSAGES mà mình không có vào @everyone.
    const escalateEveryone = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${everyoneRoleId}`,
      headers: auth(bob.token),
      payload: {
        permissions: serializePermissions(DEFAULT_EVERYONE | Permission.MANAGE_MESSAGES),
      },
    });
    expect(escalateEveryone.statusCode).toBe(403);

    // @everyone thêm MANAGE_MESSAGES → bob xoá được tin của người khác.
    const target = await sendMessage(ctx, alice.token, generalId, "tin của alice");
    const beforeGrant = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${target.id}`,
      headers: auth(bob.token),
    });
    expect(beforeGrant.statusCode).toBe(403);

    const granted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${everyoneRoleId}`,
      headers: auth(alice.token),
      payload: {
        permissions: serializePermissions(DEFAULT_EVERYONE | Permission.MANAGE_MESSAGES),
      },
    });
    expect(granted.statusCode).toBe(200);

    const afterGrant = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${target.id}`,
      headers: auth(bob.token),
    });
    expect(afterGrant.statusCode).toBe(204);

    // Trả về mặc định → quyền hết ngay.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${everyoneRoleId}`,
      headers: auth(alice.token),
      payload: { permissions: serializePermissions(DEFAULT_EVERYONE) },
    });
    const nextTarget = await sendMessage(ctx, alice.token, generalId, "tin sau khi thu");
    const afterRevoke = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${nextTarget.id}`,
      headers: auth(bob.token),
    });
    expect(afterRevoke.statusCode).toBe(403);
  });
});
