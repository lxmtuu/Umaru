import type { Role } from "@umaru/protocol";

/**
 * Tính vị trí thả cho danh sách role trong Server Settings.
 *
 * Hai chiều khác nhau, đây là chỗ dễ sai nhất:
 * - `Role.position` (protocol/server): **cao = mạnh hơn**, `@everyone` = 0.
 * - Thứ hạng kéo-thả (index trong danh sách hiển thị): **0 = trên cùng**, và
 *   **không tính** `@everyone`.
 *
 * `PATCH /guilds/:id/roles/:roleId { position }` nhận đúng thứ hạng kéo-thả này,
 * nên helper trả về số đó chứ không phải `Role.position`.
 */

/** Các role kéo được, xếp trên xuống: bỏ `@everyone`, sắp theo `position` giảm dần. */
export function draggableRoles(roles: Role[]): Role[] {
  return roles
    .filter((role) => !role.isEveryone)
    .slice()
    .sort((a, b) => b.position - a.position || (a.id < b.id ? 1 : -1));
}

export type RoleDropTarget = { roleId: string; zone: "before" | "after" };

/**
 * Thứ hạng mới cho `draggedId` khi thả lên `target`.
 *
 * `null` = không làm gì: thả lên chính nó, hoặc đích không nằm trong danh sách
 * kéo được (ví dụ `@everyone`). Kéo xuống thì phải trừ 1 vì kéo role ra khỏi
 * danh sách làm các role phía dưới nhích lên một bậc.
 */
export function resolveRoleDrop(
  roles: Role[],
  draggedId: string,
  target: RoleDropTarget | null,
): number | null {
  if (target === null || target.roleId === draggedId) return null;
  const order = draggableRoles(roles);
  const from = order.findIndex((role) => role.id === draggedId);
  const to = order.findIndex((role) => role.id === target.roleId);
  if (from < 0 || to < 0) return null;
  const insertAt = target.zone === "after" ? to + 1 : to;
  return insertAt > from ? insertAt - 1 : insertAt;
}

/** Có thật sự đổi chỗ không — tránh gọi API khi thả đúng chỗ cũ. */
export function roleDropChangesOrder(
  roles: Role[],
  draggedId: string,
  target: RoleDropTarget | null,
): boolean {
  const next = resolveRoleDrop(roles, draggedId, target);
  if (next === null) return false;
  return draggableRoles(roles).findIndex((role) => role.id === draggedId) !== next;
}
