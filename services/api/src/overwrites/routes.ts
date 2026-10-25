import {
  ALL_PERMISSIONS,
  Permission,
  hasPermission,
  parsePermissions,
  serializePermissions,
  type ChannelOverwrite,
  type Snowflake,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadGuildContext, highestRolePosition, type GuildContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, forbidden, notFound, readId } from "../http.js";
import type { ChannelRow } from "../mappers.js";

export interface OverwriteDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

/** Sửa ghi đè quyền = quản lý kênh hoặc quản lý role (giống Discord). */
const MANAGE_OVERWRITES = Permission.MANAGE_CHANNELS | Permission.MANAGE_ROLES;

const TARGET_TYPES = new Set(["role", "member"]);

interface OverwriteRow {
  channel_id: string;
  target_type: "role" | "member";
  target_id: string;
  allow: string;
  deny: string;
  target_name: string | null;
  role_color: number | null;
  is_everyone: boolean | null;
  role_position: number | null;
}

const OVERWRITE_SELECT = `
  SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny,
         COALESCE(r.name, u.display_name) AS target_name,
         r.color AS role_color, r.is_everyone, r.position AS role_position
    FROM permission_overwrites o
    LEFT JOIN roles r ON o.target_type = 'role' AND r.id = o.target_id
    LEFT JOIN users u ON o.target_type = 'member' AND u.id = o.target_id
   WHERE o.channel_id = $1`;

/**
 * Ghi đè quyền theo kênh (docs/data-model.md §4). Cùng hai lớp bảo vệ với role:
 * - phân cấp: không đụng role/thành viên có cấp cao hơn mình (owner/ADMIN bỏ qua);
 * - mask quyền: `allow` phải là tập con quyền mình đang có — không tự mở khoá
 *   quyền mình không có. `deny` thì luôn được (từ chối không phải leo thang).
 *
 * Mọi thay đổi gọi `refreshGuildVisibility` → server đẩy lại `PERMISSIONS_UPDATE`
 * và `CHANNEL_CREATE`/`CHANNEL_DELETE` cho session đang mở của người bị ảnh hưởng.
 */
export function registerOverwriteRoutes(app: FastifyInstance, deps: OverwriteDeps): void {
  const { pool, tokens, publisher } = deps;
  const guard = createAuthGuard(tokens);

  app.get<{ Params: { channelId: string } }>(
    "/channels/:channelId/overwrites",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channel } = await loadSettingsChannel(pool, userId, request.params.channelId);
      const result = await pool.query<OverwriteRow>(`${OVERWRITE_SELECT} ORDER BY o.target_type DESC, o.target_id`, [
        channel.id,
      ]);
      return reply.send(sortOverwrites(result.rows).map(mapOverwrite));
    },
  );

  app.put<{ Params: { channelId: string; targetType: string; targetId: string } }>(
    "/channels/:channelId/overwrites/:targetType/:targetId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channel, context } = await loadSettingsChannel(
        pool,
        userId,
        request.params.channelId,
      );
      const guildId = channel.guild_id ?? "";
      const targetType = readTargetType(request.params.targetType);
      const targetId = readId(request.params, "targetId");
      if (targetId === null) throw badRequest("targetId phải là snowflake (chuỗi số)");

      const body = request.body as Record<string, unknown> | undefined;
      const allow = readBits(body?.allow, "allow");
      const deny = readBits(body?.deny, "deny");
      if ((allow & deny) !== 0n) {
        throw badRequest("allow và deny không được trùng bit");
      }

      await requireTargetInReach(pool, context, guildId, targetType, targetId);
      requireCanGrant(context, allow);

      if (allow === 0n && deny === 0n) {
        // Không cho/không cấm = không có ghi đè → xoá dòng thay vì lưu bitfield 0.
        await pool.query(
          "DELETE FROM permission_overwrites WHERE channel_id = $1 AND target_id = $2",
          [channel.id, targetId],
        );
        await publisher.refreshGuildVisibility(guildId);
        return reply.code(204).send();
      }

      await pool.query(
        `INSERT INTO permission_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, target_id)
         DO UPDATE SET target_type = EXCLUDED.target_type,
                       allow = EXCLUDED.allow,
                       deny = EXCLUDED.deny`,
        [channel.id, targetType, targetId, serializePermissions(allow), serializePermissions(deny)],
      );
      await publisher.refreshGuildVisibility(guildId);

      const saved = await pool.query<OverwriteRow>(
        `${OVERWRITE_SELECT} AND o.target_id = $2`,
        [channel.id, targetId],
      );
      const row = saved.rows[0];
      if (row === undefined) throw new Error("Không đọc được overwrite vừa lưu");
      return reply.send(mapOverwrite(row));
    },
  );

  app.delete<{ Params: { channelId: string; targetType: string; targetId: string } }>(
    "/channels/:channelId/overwrites/:targetType/:targetId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channel, context } = await loadSettingsChannel(
        pool,
        userId,
        request.params.channelId,
      );
      const guildId = channel.guild_id ?? "";
      const targetType = readTargetType(request.params.targetType);
      const targetId = readId(request.params, "targetId");
      if (targetId === null) throw badRequest("targetId phải là snowflake (chuỗi số)");

      await requireTargetInReach(pool, context, guildId, targetType, targetId);
      // Idempotent: bấm "đặt lại" hai lần vẫn 204.
      await pool.query(
        "DELETE FROM permission_overwrites WHERE channel_id = $1 AND target_id = $2",
        [channel.id, targetId],
      );
      await publisher.refreshGuildVisibility(guildId);
      return reply.code(204).send();
    },
  );
}

/**
 * Kênh phải thuộc một guild (DM không có role/overwrite) và user phải có
 * `MANAGE_CHANNELS` hoặc `MANAGE_ROLES` ở cấp guild — quyền theo kênh không
 * được dùng để tự nới quyền cho chính mình.
 */
async function loadSettingsChannel(
  pool: Pool,
  userId: Snowflake,
  channelId: string,
): Promise<{ channel: ChannelRow; context: GuildContext }> {
  const result = await pool.query<ChannelRow>(
    `SELECT id, guild_id, type, name, topic, parent_id, position
       FROM channels WHERE id = $1`,
    [channelId],
  );
  const channel = result.rows[0];
  if (channel === undefined || channel.guild_id === null) throw notFound("Kênh không tồn tại");

  const context = await loadGuildContext(pool, userId, channel.guild_id);
  if (context === null) throw notFound("Kênh không tồn tại");

  const allowed =
    hasPermission(context.permissions, Permission.MANAGE_CHANNELS) ||
    hasPermission(context.permissions, Permission.MANAGE_ROLES);
  if (!allowed) throw forbidden("Cần quyền MANAGE_CHANNELS hoặc MANAGE_ROLES");
  return { channel, context };
}

/** Role/thành viên phải tồn tại trong server và không cao hơn cấp của actor. */
async function requireTargetInReach(
  pool: Pool,
  context: GuildContext,
  guildId: string,
  targetType: "role" | "member",
  targetId: string,
): Promise<void> {
  const actorPosition = highestRolePosition(context);
  const isAdmin = hasPermission(context.permissions, Permission.ADMINISTRATOR);

  if (targetType === "role") {
    const result = await pool.query<{ position: number }>(
      "SELECT position FROM roles WHERE id = $1 AND guild_id = $2",
      [targetId, guildId],
    );
    const role = result.rows[0];
    if (role === undefined) throw notFound("Role không tồn tại trong server");
    if (!isAdmin && role.position > actorPosition) {
      throw forbidden("Không thể sửa quyền của role cao hơn cấp mình");
    }
    return;
  }

  const member = await pool.query(
    "SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2",
    [guildId, targetId],
  );
  if (member.rowCount === 0) throw notFound("Thành viên không tồn tại trong server");
  if (isAdmin) return;

  const position = await pool.query<{ position: number }>(
    `SELECT COALESCE(MAX(r.position), 0) AS position
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.guild_id = $1 AND mr.user_id = $2`,
    [guildId, targetId],
  );
  if ((position.rows[0]?.position ?? 0) > actorPosition) {
    throw forbidden("Không thể sửa quyền của thành viên có cấp cao hơn mình");
  }
}

/** `allow` không được chứa quyền actor không có (owner/ADMIN bỏ qua). */
function requireCanGrant(context: GuildContext, allow: bigint): void {
  if (hasPermission(context.permissions, Permission.ADMINISTRATOR)) return;
  const outside = allow & ~context.permissions;
  if (outside !== 0n) {
    throw forbidden("Không thể cho quyền mà bạn không có");
  }
}

function readTargetType(raw: string): "role" | "member" {
  if (!TARGET_TYPES.has(raw)) throw badRequest("targetType phải là role hoặc member");
  return raw as "role" | "member";
}

/** Bitfield từ body dạng chuỗi thập phân; bit lạ bị bỏ, không làm hỏng bitfield. */
function readBits(raw: unknown, field: string): bigint {
  if (raw === undefined || raw === null) return 0n;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw badRequest(`"${field}" phải là bitfield dạng chuỗi thập phân`);
  }
  return parsePermissions(raw) & ALL_PERMISSIONS;
}

function sortOverwrites(rows: OverwriteRow[]): OverwriteRow[] {
  return [...rows].sort((a, b) => {
    if (a.target_type !== b.target_type) return a.target_type === "role" ? -1 : 1;
    if (a.target_type === "role") {
      return (b.role_position ?? 0) - (a.role_position ?? 0);
    }
    return (a.target_name ?? "").localeCompare(b.target_name ?? "");
  });
}

function mapOverwrite(row: OverwriteRow): ChannelOverwrite {
  return {
    channelId: row.channel_id as Snowflake,
    targetType: row.target_type,
    targetId: row.target_id as Snowflake,
    targetName: row.target_name ?? `#${row.target_id.slice(-4)}`,
    isEveryone: row.is_everyone ?? false,
    color: row.role_color ?? 0,
    allow: row.allow,
    deny: row.deny,
  };
}
