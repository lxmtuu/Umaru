import type { Role } from "@umaru/protocol";
import { describe, expect, it } from "vitest";
import {
  draggableRoles,
  resolveRoleDrop,
  roleDropChangesOrder,
} from "./roleOrder.js";

function role(id: string, name: string, position: number, isEveryone = false): Role {
  return { id, name, color: 0, position, permissions: "0", isEveryone } as unknown as Role;
}

/**
 * Danh sách hiển thị (trên xuống): Admin(4) Mod(3) Helper(1) — cố ý để trống số 2
 * vì server chỉ renumber khi có người kéo; helper phải sắp theo `position` chứ
 * không tin vào chỉ số mảng.
 */
const roles: Role[] = [
  role("ev", "@everyone", 0, true),
  role("mod", "Mod", 3),
  role("admin", "Admin", 4),
  role("helper", "Helper", 1),
];

describe("roleOrder", () => {
  it("bỏ @everyone và sắp theo cấp (cao trước)", () => {
    expect(draggableRoles(roles).map((item) => item.name)).toEqual([
      "Admin",
      "Mod",
      "Helper",
    ]);
  });

  it("thả nửa trên = chèn trước, nửa dưới = chèn sau", () => {
    // Kéo Helper lên trước Admin → thứ hạng 0.
    expect(resolveRoleDrop(roles, "helper", { roleId: "admin", zone: "before" })).toBe(0);
    // Kéo Helper lên sau Admin (tức giữa Admin và Mod) → thứ hạng 1.
    expect(resolveRoleDrop(roles, "helper", { roleId: "admin", zone: "after" })).toBe(1);
  });

  it("kéo xuống phải trừ một bậc: bỏ role ra khỏi danh sách làm role dưới nhích lên", () => {
    // Admin xuống dưới Helper: đích ở index 2, sau khi bỏ Admin thì Helper ở index 1
    // → chèn sau Helper = 2 chứ không phải 3.
    expect(resolveRoleDrop(roles, "admin", { roleId: "helper", zone: "after" })).toBe(2);
    // Admin xuống ngay trên Helper.
    expect(resolveRoleDrop(roles, "admin", { roleId: "helper", zone: "before" })).toBe(1);
  });

  it("đích không hợp lệ thì không làm gì", () => {
    expect(resolveRoleDrop(roles, "admin", null)).toBeNull();
    expect(resolveRoleDrop(roles, "admin", { roleId: "admin", zone: "before" })).toBeNull();
    // @everyone không phải đích kéo-thả.
    expect(resolveRoleDrop(roles, "admin", { roleId: "ev", zone: "before" })).toBeNull();
    expect(resolveRoleDrop(roles, "không-tồn-tại", { roleId: "mod", zone: "before" })).toBeNull();
  });

  it("thả đúng chỗ cũ thì không gọi API", () => {
    expect(roleDropChangesOrder(roles, "admin", { roleId: "mod", zone: "before" })).toBe(false);
    expect(roleDropChangesOrder(roles, "admin", { roleId: "mod", zone: "after" })).toBe(true);
    // Helper đang ở cuối: thả xuống dưới Mod cũng là cuối → không đổi.
    expect(roleDropChangesOrder(roles, "helper", { roleId: "mod", zone: "after" })).toBe(false);
  });

  it("danh sách chỉ có @everyone thì không kéo được gì", () => {
    const onlyEveryone = [role("ev", "@everyone", 0, true)];
    expect(draggableRoles(onlyEveryone)).toEqual([]);
    expect(resolveRoleDrop(onlyEveryone, "ev", { roleId: "ev", zone: "before" })).toBeNull();
  });
});
