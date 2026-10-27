import type {
  Channel,
  Message,
  MessageSearchHit,
  Snowflake,
  UserSummary,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { listGuildChannelsForUser, loadChannelContext } from "../access.js";
import { loadAttachmentsByMessage } from "../attachments.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import { notBlockedAuthorSql } from "../blocks.js";
import type { TokenService } from "../auth/tokens.js";
import type { Pool } from "../db.js";
import { badRequest, readLimit } from "../http.js";

export interface SearchDeps {
  pool: Pool;
  tokens: TokenService;
}

interface SearchRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  pinned: boolean;
  created_at: Date;
  edited_at: Date | null;
  guild_id: string | null;
  channel_type: Channel["type"];
  channel_name: string | null;
  channel_topic: string | null;
  channel_parent_id: string | null;
  channel_position: number;
  channel_slowmode_seconds: number;
  author_username: string;
  author_display_name: string;
  author_avatar_url: string | null;
  guild_name: string | null;
  recipient_user_id: string | null;
  recipient_username: string | null;
  recipient_display_name: string | null;
  recipient_avatar_url: string | null;
}

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

/**
 * Đọc `q` từ query string.
 *
 * Tối thiểu 2 ký tự: một ký tự sẽ khớp gần như mọi tin và biến tìm kiếm thành
 * quét toàn bộ lịch sử. Tối đa 100 để câu SQL không phình to.
 */
export function readSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest('Thiếu tham số "q"');
  const value = raw.trim();
  const length = [...value].length;
  if (length < MIN_QUERY_LENGTH || length > MAX_QUERY_LENGTH) {
    throw badRequest(`"q" phải dài ${MIN_QUERY_LENGTH}–${MAX_QUERY_LENGTH} ký tự`);
  }
  return value;
}

/**
 * Biến chuỗi người dùng thành pattern ILIKE an toàn.
 *
 * `%` và `_` là ký tự đại diện của LIKE — nếu để nguyên thì tìm "100%" hay
 * "snake_case" sẽ khớp bừa. Escape bằng `\` và khai báo `ESCAPE '\'` trong câu SQL.
 */
export function toLikePattern(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function readBefore(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw)) {
    throw badRequest("before phải là snowflake");
  }
  return raw;
}

const SELECT_COLUMNS = `
  m.id, m.channel_id, m.author_id, m.content, m.reply_to_id, m.pinned,
  m.created_at, m.edited_at,
  c.guild_id, c.type AS channel_type, c.name AS channel_name,
  c.topic AS channel_topic, c.parent_id AS channel_parent_id,
  c.position AS channel_position, c.slowmode_seconds AS channel_slowmode_seconds,
  u.username AS author_username, u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url,
  g.name AS guild_name,
  dm_user.id AS recipient_user_id, dm_user.username AS recipient_username,
  dm_user.display_name AS recipient_display_name,
  dm_user.avatar_url AS recipient_avatar_url`;

/**
 * Đối tác của DM (người ở đầu bên kia) — chỉ áp cho kênh `dm`, dùng chung với
 * tab Mentions để dòng kết quả hiện được "@tên" thay vì kênh không tên.
 */
const DM_LATERAL_JOIN = `
  LEFT JOIN LATERAL (
    SELECT other_user.id, other_user.username, other_user.display_name, other_user.avatar_url
      FROM channel_members mine
      JOIN channel_members theirs
        ON theirs.channel_id = mine.channel_id AND theirs.user_id <> mine.user_id
      JOIN users other_user ON other_user.id = theirs.user_id
     WHERE mine.channel_id = c.id AND mine.user_id = $1
     LIMIT 1
  ) dm_user ON c.type = 'dm'`;

function mapHit(row: SearchRow): MessageSearchHit {
  const channel: Channel = {
    id: row.channel_id as Snowflake,
    guildId: (row.guild_id ?? null) as Snowflake | null,
    type: row.channel_type,
    name: row.channel_name,
    topic: row.channel_topic,
    categoryId: (row.channel_parent_id ?? null) as Snowflake | null,
    position: row.channel_position,
    slowmodeSeconds: row.channel_slowmode_seconds,
  };
  const author: UserSummary = {
    userId: row.author_id as Snowflake,
    username: row.author_username,
    displayName: row.author_display_name,
    avatarUrl: row.author_avatar_url,
  };
  const recipient: UserSummary | null =
    row.recipient_user_id === null
      ? null
      : {
          userId: row.recipient_user_id as Snowflake,
          username: row.recipient_username ?? "",
          displayName: row.recipient_display_name ?? "",
          avatarUrl: row.recipient_avatar_url,
        };
  const message: Message = {
    id: row.id as Snowflake,
    channelId: row.channel_id as Snowflake,
    authorId: row.author_id as Snowflake,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at === null ? null : row.edited_at.toISOString(),
    replyToId: row.reply_to_id === null ? null : (row.reply_to_id as Snowflake),
    attachments: [],
    pinned: row.pinned,
    // Kết quả tìm kiếm là trích đoạn để nhảy tới tin; chip reaction chỉ có ở
    // khung chat thật nên ở đây để rỗng.
    reactions: [],
  };
  return { message, channel, guildName: row.guild_name, author, recipient };
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchDeps): void {
  const { pool } = deps;
  const guard = createAuthGuard(deps.tokens);

  /**
   * Tìm trong một kênh (kể cả DM). Quyền kiểm bằng `loadChannelContext` nên kênh
   * không xem được trả 404 như mọi route tin nhắn khác.
   */
  app.get<{ Params: { channelId: string }; Querystring: { q?: string; before?: string; limit?: string } }>(
    "/channels/:channelId/messages/search",
    { preHandler: guard },
    async (request) => {
      const userId = requireUserId(request);
      await loadChannelContext(pool, userId as Snowflake, request.params.channelId);

      const q = readSearchQuery(request.query.q);
      const before = readBefore(request.query.before);
      const limit = readLimit(request.query.limit, 25, 50);

      const result = await pool.query<SearchRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u    ON u.id = m.author_id
           LEFT JOIN guilds g ON g.id = c.guild_id
           ${DM_LATERAL_JOIN}
          WHERE m.channel_id = $2
            AND m.content ILIKE $3 ESCAPE '\\'
            AND ($4::bigint IS NULL OR m.id < $4)
            AND ${notBlockedAuthorSql("$1", "m.author_id")}
            AND NOT EXISTS (
              SELECT 1
                FROM channel_members other
                JOIN relationships rb ON rb.type = 'blocked'
                 AND ((rb.user_id = $1 AND rb.target_id = other.user_id)
                   OR (rb.user_id = other.user_id AND rb.target_id = $1))
               WHERE other.channel_id = c.id AND other.user_id <> $1
            )
          ORDER BY m.id DESC
          LIMIT $5`,
        [userId, request.params.channelId, toLikePattern(q), before, limit],
      );
      return withAttachments(pool, result.rows);
    },
  );

  /**
   * Tìm trong toàn server, **chỉ trong các kênh user đang xem được**.
   *
   * Lọc `c.id = ANY(...)` ngay trong SQL, trước `LIMIT`: lọc sau LIMIT sẽ trả
   * trang thiếu dòng (không bù) và có nguy cơ lộ id kênh bị ẩn bằng overwrite.
   */
  app.get<{ Params: { guildId: string }; Querystring: { q?: string; before?: string; limit?: string } }>(
    "/guilds/:guildId/messages/search",
    { preHandler: guard },
    async (request) => {
      const userId = requireUserId(request);
      const q = readSearchQuery(request.query.q);
      const before = readBefore(request.query.before);
      const limit = readLimit(request.query.limit, 25, 50);

      // 404 nếu không phải thành viên server.
      const { channels } = await listGuildChannelsForUser(
        pool,
        userId as Snowflake,
        request.params.guildId,
      );
      const visibleIds = channels.map((entry) => entry.channel.id);
      if (visibleIds.length === 0) return [];

      const result = await pool.query<SearchRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u    ON u.id = m.author_id
           LEFT JOIN guilds g ON g.id = c.guild_id
           ${DM_LATERAL_JOIN}
          WHERE c.guild_id = $2
            AND c.id = ANY($3::bigint[])
            AND m.content ILIKE $4 ESCAPE '\\'
            AND ($5::bigint IS NULL OR m.id < $5)
            -- Tin của người đã chặn nhau không xuất hiện trong kết quả tìm kiếm.
            AND ${notBlockedAuthorSql("$1", "m.author_id")}
          ORDER BY m.id DESC
          LIMIT $6`,
        [userId, request.params.guildId, visibleIds, toLikePattern(q), before, limit],
      );
      return withAttachments(pool, result.rows);
    },
  );
}

/** Nạp tệp đính kèm theo lô để dòng kết quả hiện được chip 📎. */
async function withAttachments(pool: Pool, rows: SearchRow[]): Promise<MessageSearchHit[]> {
  const hits = rows.map(mapHit);
  const attachments = await loadAttachmentsByMessage(
    pool,
    rows.map((row) => row.id),
  );
  for (const hit of hits) {
    hit.message.attachments = attachments.get(hit.message.id) ?? [];
  }
  return hits;
}
