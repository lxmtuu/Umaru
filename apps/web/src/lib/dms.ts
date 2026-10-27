import type { DmChannelSummary, GuildMemberSummary } from "@umaru/protocol";

/**
 * Tiện ích hiển thị cho DM 1-1 **và** group DM.
 *
 * Một `DmChannelSummary` dùng chung cho cả hai loại (server gửi `recipients` =
 * mọi người khác trong cuộc). Những chỗ chỉ có nghĩa với DM 1-1 (`recipient`)
 * phải đi qua đây để không phải rải `if (type === "group_dm")` khắp component.
 */

export function isGroupDm(dm: DmChannelSummary): boolean {
  return dm.channel.type === "group_dm";
}

/** Người bên kia của DM 1-1; group DM → null. */
export function dmPeer(dm: DmChannelSummary): GuildMemberSummary | null {
  return isGroupDm(dm) ? null : dm.recipient;
}

/**
 * Tên hiển thị: tên nhóm nếu có, ngược lại ghép tên thành viên ("An, Bình, Chi…").
 * DM 1-1 không bao giờ có tên riêng nên luôn ra tên người kia.
 */
export function dmTitle(dm: DmChannelSummary): string {
  if (dm.name !== null && dm.name.trim().length > 0) return dm.name;
  const names = dm.recipients.map((member) => member.displayName);
  if (names.length === 0) return "—";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

/** Ảnh đại diện để hiện trong sidebar: DM 1-1 dùng avatar người kia, nhóm để trống. */
export function dmAvatarUrl(dm: DmChannelSummary): string | null {
  return isGroupDm(dm) ? null : (dm.recipient?.avatarUrl ?? null);
}

/** Chữ cái đầu khi chưa có ảnh: nhóm dùng 👥, DM 1-1 dùng tên người kia. */
export function dmInitial(dm: DmChannelSummary): string {
  if (isGroupDm(dm)) return "👥";
  return (dmPeer(dm)?.displayName ?? "?").slice(0, 1).toUpperCase();
}

/** Số người trong cuộc (tính cả mình). */
export function dmMemberCount(dm: DmChannelSummary): number {
  return dm.recipients.length + 1;
}

/** Mọi người khác trong cuộc — dùng để dựng bảng tra tên/avatar khi render tin. */
export function dmRecipients(dm: DmChannelSummary): GuildMemberSummary[] {
  return dm.recipients;
}
