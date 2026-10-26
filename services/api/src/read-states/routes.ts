import type {
  Channel,
  Message,
  MessageMention,
  Snowflake,
  UserSummary,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, readId, readLimit } from "../http.js";
import { loadAttachmentsByMessage } from "../attachments.js";
import { notBlockedAuthorSql } from "../blocks.js";
import { loadBootstrap, loadReadStates } from "../bootstrap.js";

interface MentionRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  pinned: boolean;
  created_at: Date;
  edited_at: Date | null;
  guild_id: string | null;
  channel_type: string;
  channel_name: string | null;
  channel_topic: string | null;
  channel_parent_id: string | null;
  channel_position: number;
  author_username: string;
  author_display_name: string;
  author_avatar_url: string | null;
  guild_name: string | null;
  recipient_user_id: string | null;
  recipient_username: string | null;
  recipient_display_name: string | null;
  recipient_avatar_url: string | null;
}

export interface ReadStateDeps {
  pool: Pool;
  tokens: TokenService;
  publisher: EventPublisher;
}

/**
 * Đánh dấu đã đọc tới một tin. Không truyền `messageId` → lấy tin mới nhất của
 * kênh (trường hợp client vừa mở kênh lúc không có tin nào).
 */
export function registerReadStateRoutes(app: FastifyInstance, deps: ReadStateDeps): void {
  const { pool } = deps;
  const guard = createAuthGuard(deps.tokens);

  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/read",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channelId } = request.params;
      // 404 nếu user không thấy kênh này (không lộ sự tồn tại).
      await loadChannelContext(pool, userId as Snowflake, channelId);

      const body = request.body as Record<string, unknown> | undefined;
      const requested = readId(body, "messageId");

      let messageId = requested;
      if (messageId === null) {
        const latest = await pool.query<{ id: string }>(
          "SELECT id FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1",
          [channelId],
        );
        messageId = latest.rows[0]?.id ?? "0";
      } else {
        const belongs = await pool.query(
          "SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2",
          [messageId, channelId],
        );
        if (belongs.rowCount === 0) throw badRequest("Tin nhắn không thuộc kênh này");
      }

      // GREATEST: hai tab gửi lệch thứ tự không được kéo mốc đã đọc về sau.
      await pool.query(
        `INSERT INTO read_states (user_id, channel_id, last_read_message_id)
              VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id)
         DO UPDATE SET last_read_message_id =
              GREATEST(read_states.last_read_message_id, EXCLUDED.last_read_message_id)`,
        [userId, channelId, messageId],
      );

      // Cùng một người, nhiều thiết bị: tab khác (điện thoại) phải thấy badge
      // tắt ngay, không đợi mở lại kênh. Số liệu lấy lại từ DB (không tự tính ở
      // client) vì `GREATEST` có thể đã bị tab khác đẩy mốc xa hơn.
      const [readState] = await loadReadStates(pool, userId as Snowflake, [channelId]);
      if (readState !== undefined) {
        deps.publisher.publishToUser(userId, "READ_STATE_UPDATE", readState);
      }
      return reply.code(204).send();
    },
  );

  /**
   * Đồng bộ lại toàn bộ mốc đã đọc (dùng khi client muốn refresh ngoài READY).
   * Đi qua `loadBootstrap` để chỉ trả những kênh user thật sự được xem — không
   * lộ id kênh bị ẩn bằng permission overwrite.
   */
  app.get("/users/@me/read-states", { preHandler: guard }, async (request) => {
    const userId = requireUserId(request);
    const bootstrap = await loadBootstrap(pool, userId as Snowflake);
    return bootstrap.readStates;
  });

  /**
   * Danh sách tin có @gọi mình (mới nhất trước), kèm kênh để nhảy tới.
   * Lọc theo quyền xem hiện tại: mất VIEW_CHANNEL là dòng biến mất khỏi tab,
   * không lộ id/kênh/tên server cho người không còn quyền.
   */
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    "/users/@me/mentions",
    { preHandler: guard },
    async (request) => {
      const userId = requireUserId(request);
      const limit = readLimit(request.query.limit, 50, 100);
      const before = request.query.before ?? null;
      if (before !== null && !/^\d{1,20}$/.test(before)) {
        throw badRequest("before phải là snowflake");
      }

      const bootstrap = await loadBootstrap(pool, userId as Snowflake);
      // Lọc quyền TRONG SQL (trước LIMIT) — nếu lọc sau LIMIT thì tab trả về
      // thiếu dòng mà không bù, và id kênh bị ẩn vẫn bị lộ.
      const visibleIds = [...bootstrap.visibleChannels];

      const result = await pool.query<MentionRow>(
        `SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to_id, m.pinned,
                m.created_at, m.edited_at,
                c.guild_id, c.type AS channel_type, c.name AS channel_name,
                c.topic AS channel_topic, c.parent_id AS channel_parent_id, c.position AS channel_position,
                u.username AS author_username, u.display_name AS author_display_name,
                u.avatar_url AS author_avatar_url,
                g.name AS guild_name,
                dm_user.id AS recipient_user_id, dm_user.username AS recipient_username,
                dm_user.display_name AS recipient_display_name,
                dm_user.avatar_url AS recipient_avatar_url
           FROM message_mentions mm
           JOIN messages m  ON m.id = mm.message_id
           JOIN channels c  ON c.id = m.channel_id
           JOIN users u     ON u.id = m.author_id
           LEFT JOIN guilds g ON g.id = c.guild_id
           LEFT JOIN LATERAL (
             SELECT other_user.id, other_user.username, other_user.display_name, other_user.avatar_url
               FROM channel_members mine
               JOIN channel_members theirs ON theirs.channel_id = mine.channel_id AND theirs.user_id <> mine.user_id
               JOIN users other_user ON other_user.id = theirs.user_id
              WHERE mine.channel_id = c.id AND mine.user_id = $1
              LIMIT 1
           ) dm_user ON c.type = 'dm'
          WHERE mm.user_id = $1
            AND ($2::bigint IS NULL OR m.id < $2)
            AND c.id = ANY($4::bigint[])
            -- Người tôi chặn (hoặc chặn tôi) không còn chen vào hộp thư nhắc.
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
          LIMIT $3`,
        [userId, before, limit, visibleIds],
      );

      const mentions: MessageMention[] = [];
      for (const row of result.rows) {
        const channel: Channel = {
          id: row.channel_id as Snowflake,
          guildId: (row.guild_id ?? null) as Snowflake | null,
          type: row.channel_type as Channel["type"],
          name: row.channel_name,
          topic: row.channel_topic,
          categoryId: (row.channel_parent_id ?? null) as Snowflake | null,
          position: row.channel_position,
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
          // Mentions inbox chỉ hiện trích đoạn, không render chip reaction → không
          // nạp thêm một câu SQL cho mỗi trang chỉ vì một trường không dùng.
          reactions: [],
        };

        mentions.push({
          message,
          channel,
          guildName: row.guild_name,
          author,
          recipient,
        });
      }
      // Nạp attachment theo lô cho cả trang (một câu SQL).
      const attachments = await loadAttachmentsByMessage(
        pool,
        result.rows.map((row) => row.id),
      );
      for (const mention of mentions) {
        mention.message.attachments = attachments.get(mention.message.id) ?? [];
      }
      return mentions;
    },
  );
}
