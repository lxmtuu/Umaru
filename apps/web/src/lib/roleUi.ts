import { Permission } from "@umaru/protocol";
import type { MessageKey } from "./i18n.js";

/** Các quyền hiển thị trong UI role/channel settings, đúng thứ tự bit. */
export const PERMISSION_ROWS: Array<{ flag: bigint; label: MessageKey }> = [
  { flag: Permission.VIEW_CHANNEL, label: "permViewChannel" },
  { flag: Permission.SEND_MESSAGES, label: "permSendMessages" },
  { flag: Permission.READ_HISTORY, label: "permReadHistory" },
  { flag: Permission.MANAGE_MESSAGES, label: "permManageMessages" },
  { flag: Permission.MANAGE_CHANNELS, label: "permManageChannels" },
  { flag: Permission.MANAGE_ROLES, label: "permManageRoles" },
  { flag: Permission.KICK_MEMBERS, label: "permKickMembers" },
  { flag: Permission.BAN_MEMBERS, label: "permBanMembers" },
  { flag: Permission.CONNECT, label: "permConnect" },
  { flag: Permission.SPEAK, label: "permSpeak" },
  { flag: Permission.MENTION_EVERYONE, label: "permMentionEveryone" },
  { flag: Permission.ADMINISTRATOR, label: "permAdministrator" },
];

/** 0xRRGGBB → "#rrggbb" cho input type="color" và chấm/chip role. */
export function colorToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function hexToColor(hex: string): number {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return Number.isFinite(value) ? value & 0xffffff : 0;
}
