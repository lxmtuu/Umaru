import type { Snowflake } from "./snowflake.js";

/**
 * Permission bitfield — bắt đầu với ~10 quyền của G1 (ROADMAP §2.1),
 * các bit 11+ dành sẵn để mở rộng mà không cần migration.
 */
export const Permission = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  MANAGE_MESSAGES: 1n << 2n,
  MANAGE_CHANNELS: 1n << 3n,
  MANAGE_ROLES: 1n << 4n,
  KICK_MEMBERS: 1n << 5n,
  BAN_MEMBERS: 1n << 6n,
  MENTION_EVERYONE: 1n << 7n,
  READ_HISTORY: 1n << 8n,
  CONNECT: 1n << 9n, // voice — G2
  SPEAK: 1n << 10n, // voice — G2
  /** Quản lý sticker/emoji của server (tạo gói, tải sticker lên, xoá). */
  MANAGE_EXPRESSIONS: 1n << 12n,
  /** Siêu quyền: bỏ qua mọi permission check khác (owner hoặc role admin). */
  ADMINISTRATOR: 1n << 11n,
} as const;

export type PermissionName = keyof typeof Permission;

/** JSON không có bigint → API/DB lưu bitfield dạng chuỗi thập phân; đây là lối duy nhất để parse. */
export function parsePermissions(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`Bitfield permission không hợp lệ: ${raw}`);
  }
  return BigInt(raw);
}

export function serializePermissions(bits: bigint): string {
  return bits.toString();
}

export function hasPermission(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

export function grantPermissions(bits: bigint, ...flags: bigint[]): bigint {
  return flags.reduce((acc, flag) => acc | flag, bits);
}

export function revokePermissions(bits: bigint, ...flags: bigint[]): bigint {
  return flags.reduce((acc, flag) => acc & ~flag, bits);
}

export function permissionNames(bits: bigint): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter((name) =>
    hasPermission(bits, Permission[name]),
  );
}

/** Tất cả bit đang được định nghĩa (dùng cho owner/ADMINISTRATOR). */
export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce(
  (acc, flag) => acc | flag,
  0n,
);

export interface PermissionRole {
  id: Snowflake;
  permissions: bigint;
}

export interface PermissionOverwriteInput {
  targetType: "role" | "member";
  targetId: Snowflake;
  allow: bigint;
  deny: bigint;
}

export interface ResolvePermissionsInput {
  userId: Snowflake;
  isGuildOwner: boolean;
  everyoneRoleId: Snowflake;
  everyonePermissions: bigint;
  /** Role của member, KHÔNG gồm @everyone. */
  memberRoles: PermissionRole[];
  /**
   * Overwrite của **category cha** (nếu kênh nằm trong category) — áp TRƯỚC
   * `overwrites`. Cùng một target: overwrite của kênh thắng category, đúng
   * thứ tự Discord (category → channel → member).
   */
  inheritedOverwrites?: PermissionOverwriteInput[];
  /** Overwrite của channel đang xét. */
  overwrites: PermissionOverwriteInput[];
}

/**
 * Phân giải quyền hiệu dụng tại một channel — cài đặt đúng thuật toán ở
 * docs/data-model.md §4. Hàm thuần: backend gọi cho cả REST và gateway,
 * client dùng lại để ẩn/hiện UI (không thay thế kiểm tra phía server).
 *
 * Quy tắc: deny trước, allow sau ở cùng cấp; overwrite của member thắng role.
 */
export function resolvePermissions(input: ResolvePermissionsInput): bigint {
  if (input.isGuildOwner) return ALL_PERMISSIONS;

  let base = input.everyonePermissions;
  for (const role of input.memberRoles) base |= role.permissions;
  if (hasPermission(base, Permission.ADMINISTRATOR)) return ALL_PERMISSIONS;

  let perms = base;
  // Category là cấp "kế thừa": áp xong mới tới overwrite của chính kênh.
  if (input.inheritedOverwrites !== undefined && input.inheritedOverwrites.length > 0) {
    perms = applyOverwriteLevel(input, perms, input.inheritedOverwrites);
  }
  perms = applyOverwriteLevel(input, perms, input.overwrites);

  // Bit lạ (không được định nghĩa) không bao giờ có hiệu lực.
  return perms & ALL_PERMISSIONS;
}

/** Một "cấp" overwrite: @everyone → union role → overwrite riêng của member. */
function applyOverwriteLevel(
  input: ResolvePermissionsInput,
  perms: bigint,
  overwrites: PermissionOverwriteInput[],
): bigint {
  let result = perms;

  const everyoneOverwrite = findOverwrite(overwrites, "role", input.everyoneRoleId);
  if (everyoneOverwrite) {
    result = (result & ~everyoneOverwrite.deny) | everyoneOverwrite.allow;
  }

  const memberRoleIds = new Set(input.memberRoles.map((role) => role.id));
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.targetType !== "role") continue;
    if (overwrite.targetId === input.everyoneRoleId) continue;
    if (!memberRoleIds.has(overwrite.targetId)) continue;
    roleAllow |= overwrite.allow;
    roleDeny |= overwrite.deny;
  }
  roleAllow &= ~roleDeny;
  result = (result & ~roleDeny) | roleAllow;

  const memberOverwrite = findOverwrite(overwrites, "member", input.userId);
  if (memberOverwrite) {
    result = (result & ~memberOverwrite.deny) | memberOverwrite.allow;
  }
  return result;
}

function findOverwrite(
  overwrites: PermissionOverwriteInput[],
  targetType: PermissionOverwriteInput["targetType"],
  targetId: Snowflake,
): PermissionOverwriteInput | undefined {
  return overwrites.find((o) => o.targetType === targetType && o.targetId === targetId);
}
