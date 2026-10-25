import { Permission, serializePermissions } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Kéo-thả đổi **cấp** role: `PATCH /guilds/:id/roles/:roleId { position }` với
 * `position` = thứ hạng từ trên xuống (0 = trên cùng, không tính `@everyone`),
 * khác hẳn `Role.position` trong response (cao = mạnh hơn).
 *
 * Trọng tâm là an toàn: không leo thang quyền qua phân cấp, `@everyone` luôn ở
 * đáy, lỗi giữa đường phải rollback chứ không để position nửa vời.
 */

let ctx: TestContext;
let alice: RegisteredUser; // owner
let bob: RegisteredUser; // có role MANAGE_ROLES
let dave: RegisteredUser; // thành viên thường
let guildId: string;
let everyoneRoleId: string;
/** Role cấp quyền MANAGE_ROLES cho bob. */
let capId: string;

interface RoleBody {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  isEveryone: boolean;
}

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "ord_alice");
  bob = await registerUser(ctx, "ord_bob");
  dave = await registerUser(ctx, "ord_dave");
  guildId = await createGuild(ctx, alice.token, "Thứ tự role");
  const channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const { code } = invite.json<{ code: string }>();
  for (const user of [bob, dave]) {
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(user.token),
    });
  }

  everyoneRoleId = (await listRoles()).at(-1)!.id;
  capId = (await createRole(alice.token, {
    name: "Cap",
    permissions: serializePermissions(
      Permission.VIEW_CHANNEL |
        Permission.SEND_MESSAGES |
        Permission.READ_HISTORY |
        Permission.MANAGE_ROLES,
    ),
  })).id;
  await ctx.app.inject({
    method: "PUT",
    url: `/api/v1/guilds/${guildId}/members/${bob.id}/roles/${capId}`,
    headers: auth(alice.token),
  });
});

afterAll(async () => {
  await ctx.close();
});

async function listRoles(): Promise<RoleBody[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: auth(alice.token),
  });
  if (response.statusCode !== 200) throw new Error(`List role lỗi: ${response.body}`);
  return response.json();
}

async function createRole(
  token: string,
  payload: Record<string, unknown>,
): Promise<RoleBody> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: auth(token),
    payload,
  });
  if (response.statusCode !== 201) throw new Error(`Tạo role lỗi: ${response.body}`);
  return response.json();
}

async function moveRole(
  token: string,
  roleId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: RoleBody & { error?: { code: string } } }> {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/guilds/${guildId}/roles/${roleId}`,
    headers: auth(token),
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

/** Thứ tự trên xuống theo tên — dễ đọc hơn so sánh position thô. */
async function order(): Promise<string[]> {
  return (await listRoles()).map((role) => role.name);
}

describe("kéo-thả đổi cấp role", () => {
  it("kéo role lên đầu: renumber lại cả dãy, trả về position mới", async () => {
    await createRole(alice.token, { name: "A" });
    const b = await createRole(alice.token, { name: "B" });
    await createRole(alice.token, { name: "C" });
    // Trên xuống: C(4) B(3) A(2) Cap(1) @everyone(0)
    expect(await order()).toEqual(["C", "B", "A", "Cap", "@everyone"]);

    const moved = await moveRole(alice.token, b.id, { position: 0 });
    expect(moved.statusCode).toBe(200);
    expect(moved.body).toMatchObject({ id: b.id, name: "B", position: 4 });

    // Không còn khoảng trống/trùng: 4..1 rồi @everyone = 0.
    expect(await order()).toEqual(["B", "C", "A", "Cap", "@everyone"]);
    const positions = (await listRoles()).map((role) => role.position);
    expect(positions).toEqual([4, 3, 2, 1, 0]);

    // Kéo xuống đáy (ngay trên @everyone).
    const down = await moveRole(alice.token, b.id, { position: 99 });
    expect(down.statusCode).toBe(200);
    expect(down.body.position).toBe(1);
    expect(await order()).toEqual(["C", "A", "Cap", "B", "@everyone"]);
  });

  it("@everyone luôn ở đáy: không kéo được và không bị renumber đẩy lên", async () => {
    const denied = await moveRole(alice.token, everyoneRoleId, { position: 0 });
    expect(denied.statusCode).toBe(400);
    expect(denied.body.error?.code).toBe("BAD_REQUEST");
    expect((await listRoles()).at(-1)).toMatchObject({ isEveryone: true, position: 0 });
  });

  it("không leo thang: người có MANAGE_ROLES không đẩy role lên trên cấp cao nhất của mình", async () => {
    // Cap cấp cho bob đang ở position 1 (giữa dãy) → bob cao nhất = 1.
    const before = await order();
    const escalation = await moveRole(bob.token, everyoneRoleId, { position: 0 });
    expect(escalation.statusCode).toBe(400); // @everyone bị chặn trước cả phân cấp

    // Role "A" hiện đang ở position 2 > 1 (trên cấp bob) → bob không đụng được.
    const aId = (await listRoles()).find((role) => role.name === "A")!.id;
    const denied = await moveRole(bob.token, aId, { position: 0 });
    expect(denied.statusCode).toBe(403);
    expect(denied.body.error?.code).toBe("FORBIDDEN");

    // Và lỗi giữa đường phải rollback — thứ tự không được xê dịch nửa vời.
    expect(await order()).toEqual(before);
    expect((await listRoles()).map((role) => role.position)).toEqual([4, 3, 2, 1, 0]);
  });

  it("thiếu MANAGE_ROLES → 403; position rác → 400", async () => {
    const roleId = (await listRoles())[0]!.id;
    const noPerm = await moveRole(dave.token, roleId, { position: 1 });
    expect(noPerm.statusCode).toBe(403);

    for (const position of [-1, 1.5, "2", Number.NaN]) {
      const bad = await moveRole(alice.token, roleId, { position });
      expect(bad.statusCode).toBe(400);
    }
    const before = await order();
    expect(await order()).toEqual(before);
  });

  it("kéo cùng lúc với đổi tên/quyền vẫn đúng (một request, hai ý định)", async () => {
    const role = (await listRoles()).find((item) => item.name === "C")!;
    const moved = await moveRole(alice.token, role.id, { position: 4, name: "C đổi tên" });
    expect(moved.statusCode).toBe(200);
    expect(moved.body).toMatchObject({ name: "C đổi tên", position: 1 });
    expect(await order()).toEqual(["A", "Cap", "B", "C đổi tên", "@everyone"]);

    // Chỉ đổi tên thì position giữ nguyên.
    const renamed = await moveRole(alice.token, role.id, { name: "C" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body).toMatchObject({ name: "C", position: 1 });
  });

  it("kéo role làm thay đổi phân cấp thật: role lên trên quản lý được role dưới", async () => {
    // Đưa Cap (MANAGE_ROLES của bob) lên trên cùng → bob quản lý được mọi role.
    const cap = (await listRoles()).find((role) => role.id === capId)!;
    // Hiện tại: A(4) Cap(3) B(2) C(1) @everyone(0).
    expect(cap.position).toBe(3);
    const up = await moveRole(alice.token, capId, { position: 0 });
    expect(up.statusCode).toBe(200);
    expect(up.body.position).toBe(4);

    const aId = (await listRoles()).find((role) => role.name === "A")!.id;
    const nowAllowed = await moveRole(bob.token, aId, { position: 3 });
    expect(nowAllowed.statusCode).toBe(200);
    expect(nowAllowed.body.position).toBe(1);
  });
});
