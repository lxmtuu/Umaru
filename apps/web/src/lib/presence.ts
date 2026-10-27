import type { GuildMemberSummary, PresenceStatus, Role } from "@umaru/protocol";

/**
 * Logic chia danh sách thành viên theo trạng thái — như Discord: người **đang
 * online** được nhóm theo role, còn lại gom vào một nhóm "Ngoại tuyến" ở cuối.
 *
 * Tách khỏi component để test được: đây là chỗ dễ sai (người không có mặt trong
 * map presence phải tính là offline, không phải "không rõ").
 */

/** Người không có trong map = chưa từng kết nối → offline. */
export function presenceOf(
  presence: Record<string, PresenceStatus> | undefined,
  userId: string,
): PresenceStatus {
  return presence?.[userId] ?? "offline";
}

export interface PresencePartition {
  online: GuildMemberSummary[];
  offline: GuildMemberSummary[];
}

/**
 * @param presence map userId → trạng thái (thiếu = offline). `"offline"` ở đây
 *   gồm cả người chọn **Ẩn**: với người khác họ đúng là offline.
 */
export function partitionByPresence(
  members: GuildMemberSummary[],
  presence: Record<string, PresenceStatus> | undefined,
): PresencePartition {
  const online: GuildMemberSummary[] = [];
  const offline: GuildMemberSummary[] = [];
  for (const member of members) {
    if (presenceOf(presence, member.userId as string) === "offline") offline.push(member);
    else online.push(member);
  }
  return { online, offline };
}

/** Màu chấm trạng thái — khớp quy ước Discord (xanh/vàng/đỏ/xám). */
export const PRESENCE_DOT: Record<PresenceStatus, string> = {
  online: "bg-emerald-400",
  idle: "bg-amber-400",
  dnd: "bg-rose-500",
  offline: "bg-slate-600",
};

/** Sắp theo trạng thái rồi theo tên, dùng cho danh sách bạn bè/DM. */
export function sortByPresence<T extends { userId: string; displayName: string }>(
  people: T[],
  presence: Record<string, PresenceStatus> | undefined,
): T[] {
  const rank: Record<PresenceStatus, number> = { online: 0, idle: 1, dnd: 2, offline: 3 };
  return [...people].sort((a, b) => {
    const diff = rank[presenceOf(presence, a.userId)] - rank[presenceOf(presence, b.userId)];
    return diff !== 0 ? diff : a.displayName.localeCompare(b.displayName, "vi");
  });
}
