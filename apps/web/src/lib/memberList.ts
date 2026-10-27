import type { GuildMemberSummary, Role } from "@umaru/protocol";

/**
 * Nhóm thành viên theo **role cao nhất** — cùng quy tắc Discord dùng cho sidebar
 * thành viên: thứ tự nhóm theo thẩm quyền role giảm dần, trong nhóm theo tên.
 *
 * Tách khỏi component để test được mà không cần render.
 */

export interface MemberSection {
  /** `"default"` cho người không có role riêng, ngược lại là role id. */
  id: string;
  name: string;
  /** `0xRRGGBB` hoặc `null` khi role không đặt màu. */
  color: number | null;
  members: GuildMemberSummary[];
}

export interface GroupOptions {
  members: GuildMemberSummary[];
  roles: Role[];
  /** Nhãn cho nhóm người chưa có role riêng (thường là "Thành viên"). */
  defaultSectionLabel: string;
}

/** Role cao nhất của một thành viên, bỏ qua `@everyone`. */
export function topRole(member: GuildMemberSummary, roleById: Map<string, Role>): Role | null {
  let best: Role | null = null;
  for (const roleId of member.roleIds) {
    const role = roleById.get(roleId);
    // Role vừa bị xoá ở server nhưng chưa kịp bỏ khỏi snapshot → bỏ qua, không
    // để người đó rơi vào nhóm "role ma".
    if (role === undefined || role.isEveryone) continue;
    if (best === null || role.position > best.position) best = role;
  }
  return best;
}

export function groupMembersByRole({ members, roles, defaultSectionLabel }: GroupOptions): MemberSection[] {
  const roleById = new Map(roles.map((role) => [role.id as string, role]));
  const sections = new Map<string, MemberSection>();

  for (const member of members) {
    const role = topRole(member, roleById);
    const id = role === null ? "default" : (role.id as string);
    let section = sections.get(id);
    if (section === undefined) {
      section = {
        id,
        name: role === null ? defaultSectionLabel : role.name,
        // Màu 0 = "không đặt màu", không phải màu đen (sẽ không đọc được trên nền tối).
        color: role === null || role.color === 0 ? null : role.color,
        members: [],
      };
      sections.set(id, section);
    }
    section.members.push(member);
  }

  const byName = (a: GuildMemberSummary, b: GuildMemberSummary) =>
    a.displayName.localeCompare(b.displayName, "vi");
  const ordered = [...sections.values()].sort((a, b) => {
    // Nhóm mặc định luôn ở cuối, giống cách Discord để nhóm không có role riêng
    // xuống dưới cùng.
    if (a.id === "default") return 1;
    if (b.id === "default") return -1;
    const roleA = roleById.get(a.id);
    const roleB = roleById.get(b.id);
    // position cao = mạnh hơn = đứng trước; bằng nhau thì theo tên role.
    const diff = (roleB?.position ?? 0) - (roleA?.position ?? 0);
    return diff !== 0 ? diff : a.name.localeCompare(b.name, "vi");
  });

  for (const section of ordered) section.members.sort(byName);
  return ordered;
}
