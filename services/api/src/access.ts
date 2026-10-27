import {
  Permission,
  hasPermission,
  parsePermissions,
  resolvePermissions,
  type PermissionOverwriteInput,
  type Snowflake,
} from "@umaru/protocol";
import type { Pool } from "./db.js";
import { forbidden, notFound } from "./http.js";
import type { ChannelRow, GuildRow } from "./mappers.js";

export interface GuildContext {
  guild: GuildRow;
  isOwner: boolean;
  everyoneRoleId: Snowflake;
  everyonePermissions: bigint;
  memberRoles: { id: Snowflake; permissions: bigint; position: number }[];
  /** Quyền cấp guild (chưa áp overwrite của channel). */
  permissions: bigint;
}

export interface ChannelContext {
  channel: ChannelRow;
  guild: GuildContext | null;
  permissions: bigint;
}

interface RoleRow {
  id: string;
  permissions: string;
  position: number;
  is_everyone: boolean;
}

export async function loadGuildContext(
  pool: Pool,
  userId: Snowflake,
  guildId: string,
): Promise<GuildContext | null> {
  const guildResult = await pool.query<GuildRow & { member_id: string | null }>(
    `SELECT g.id, g.name, g.icon_url, g.owner_id, g.created_at, gm.user_id AS member_id
       FROM guilds g
       LEFT JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = $2
      WHERE g.id = $1`,
    [guildId, userId],
  );
  const row = guildResult.rows[0];
  if (row === undefined || row.member_id === null) return null;

  const roles = await pool.query<RoleRow>(
    "SELECT id, permissions, position, is_everyone FROM roles WHERE guild_id = $1",
    [guildId],
  );
  const everyone = roles.rows.find((role) => role.is_everyone);
  if (everyone === undefined) {
    throw new Error(`Guild ${guildId} thiếu role @everyone — dữ liệu hỏng`);
  }
  const memberRoleRows = await pool.query<{ role_id: string }>(
    "SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2",
    [guildId, userId],
  );
  const memberRoleIds = new Set(memberRoleRows.rows.map((r) => r.role_id));
  const memberRoles = roles.rows
    .filter((role) => !role.is_everyone && memberRoleIds.has(role.id))
    .map((role) => ({
      id: role.id as Snowflake,
      permissions: parsePermissions(role.permissions),
      position: role.position,
    }));

  const permissions = resolvePermissions({
    userId,
    isGuildOwner: row.owner_id === userId,
    everyoneRoleId: everyone.id as Snowflake,
    everyonePermissions: parsePermissions(everyone.permissions),
    memberRoles,
    overwrites: [],
  });

  return {
    guild: row,
    isOwner: row.owner_id === userId,
    everyoneRoleId: everyone.id as Snowflake,
    everyonePermissions: parsePermissions(everyone.permissions),
    memberRoles,
    permissions,
  };
}

/**
 * Vị trí role cao nhất của member trong guild. Mọi thành viên đều có
 * @everyone (position 0) nên kết quả luôn ≥ 0 — dùng cho phân cấp role
 * (không cho user quản lý role cao hơn cấp của mình).
 */
export function highestRolePosition(context: GuildContext): number {
  let highest = 0;
  for (const role of context.memberRoles) {
    if (role.position > highest) highest = role.position;
  }
  return highest;
}

export async function loadChannelOverwrites(
  pool: Pool,
  channelId: string,
): Promise<PermissionOverwriteInput[]> {
  const result = await pool.query<{
    target_type: "role" | "member";
    target_id: string;
    allow: string;
    deny: string;
  }>(
    "SELECT target_type, target_id, allow, deny FROM permission_overwrites WHERE channel_id = $1",
    [channelId],
  );
  return result.rows.map((row) => ({
    targetType: row.target_type,
    targetId: row.target_id as Snowflake,
    allow: parsePermissions(row.allow),
    deny: parsePermissions(row.deny),
  }));
}

export function resolveChannelPermissions(
  context: GuildContext,
  userId: Snowflake,
  overwrites: PermissionOverwriteInput[],
  inheritedOverwrites: PermissionOverwriteInput[] = [],
): bigint {
  return resolvePermissions({
    userId,
    isGuildOwner: context.isOwner,
    everyoneRoleId: context.everyoneRoleId,
    everyonePermissions: context.everyonePermissions,
    memberRoles: context.memberRoles,
    inheritedOverwrites,
    overwrites,
  });
}

/**
 * Tải channel + quyền hiệu dụng của user tại channel đó.
 * Không phải thành viên / không có VIEW_CHANNEL → 404 (không lộ sự tồn tại).
 */
export async function loadChannelContext(
  pool: Pool,
  userId: Snowflake,
  channelId: string,
  required: bigint | null = null,
): Promise<ChannelContext> {
  const channelResult = await pool.query<ChannelRow>(
    `SELECT id, guild_id, type, name, topic, parent_id, position, slowmode_seconds
       FROM channels WHERE id = $1`,
    [channelId],
  );
  const channel = channelResult.rows[0];
  if (channel === undefined) throw notFound("Kênh không tồn tại");

  if (channel.guild_id === null) {
    const member = await pool.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2",
      [channelId, userId],
    );
    if (member.rowCount === 0) throw notFound("Kênh không tồn tại");
    const permissions =
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY;
    if (required !== null && !hasPermission(permissions, required)) {
      throw forbidden("Không có quyền trong kênh này");
    }
    return { channel, guild: null, permissions };
  }

  const guild = await loadGuildContext(pool, userId, channel.guild_id);
  if (guild === null) throw notFound("Kênh không tồn tại");

  const overwrites = await loadChannelOverwrites(pool, channelId);
  // Kênh nằm trong category → overwrite của category áp trước, kênh đè lên sau.
  const inheritedOverwrites =
    channel.parent_id === null ? [] : await loadChannelOverwrites(pool, channel.parent_id);
  const permissions = resolveChannelPermissions(guild, userId, overwrites, inheritedOverwrites);

  if (!hasPermission(permissions, Permission.VIEW_CHANNEL)) {
    throw notFound("Kênh không tồn tại");
  }
  if (required !== null && !hasPermission(permissions, required)) {
    throw forbidden("Không có quyền thực hiện thao tác này");
  }
  return { channel, guild, permissions };
}

export interface VisibleChannel {
  channel: ChannelRow;
  permissions: bigint;
}

/** Các kênh user được xem trong một guild (dùng cho GET /guilds/:id/channels). */
export async function listGuildChannelsForUser(
  pool: Pool,
  userId: Snowflake,
  guildId: string,
): Promise<{ context: GuildContext; channels: VisibleChannel[] }> {
  const context = await loadGuildContext(pool, userId, guildId);
  if (context === null) throw notFound("Server không tồn tại");

  const channelResult = await pool.query<ChannelRow>(
    `SELECT id, guild_id, type, name, topic, parent_id, position, slowmode_seconds
       FROM channels
      WHERE guild_id = $1 AND type <> 'guild_thread'
      ORDER BY position, id`,
    [guildId],
  );
  const overwriteResult = await pool.query<{
    channel_id: string;
    target_type: "role" | "member";
    target_id: string;
    allow: string;
    deny: string;
  }>(
    `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
       FROM permission_overwrites o
       JOIN channels c ON c.id = o.channel_id
      WHERE c.guild_id = $1`,
    [guildId],
  );

  const byChannel = new Map<string, PermissionOverwriteInput[]>();
  for (const row of overwriteResult.rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push({
      targetType: row.target_type,
      targetId: row.target_id as Snowflake,
      allow: parsePermissions(row.allow),
      deny: parsePermissions(row.deny),
    });
    byChannel.set(row.channel_id, list);
  }

  const channels: VisibleChannel[] = [];
  for (const channel of channelResult.rows) {
    const permissions = resolveChannelPermissions(
      context,
      userId,
      byChannel.get(channel.id) ?? [],
      channel.parent_id === null ? [] : (byChannel.get(channel.parent_id) ?? []),
    );
    if (hasPermission(permissions, Permission.VIEW_CHANNEL)) {
      channels.push({ channel, permissions });
    }
  }
  return { context, channels };
}

export async function requireGuildPermission(
  pool: Pool,
  userId: Snowflake,
  guildId: string,
  required: bigint,
): Promise<GuildContext> {
  const context = await loadGuildContext(pool, userId, guildId);
  if (context === null) throw notFound("Server không tồn tại");
  if (!hasPermission(context.permissions, required)) {
    throw forbidden("Không có quyền thực hiện thao tác này");
  }
  return context;
}
