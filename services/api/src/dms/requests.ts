import type { MessageRequestSummary, Snowflake, UserProfile } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { notFound } from "../http.js";
import type { Stores } from "../uploads/storage.js";
import { loadDmSummary } from "./group.js";

export interface DmRequestDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
  storage: Stores;
}

/**
 * Trần số yêu cầu nhắn tin **đang chờ** của một người gửi.
 *
 * Không phải rate limit theo thời gian (đã có 20 tin/phút ở tầng tin nhắn) mà là
 * giới hạn *tồn đọng*: nếu mỗi yêu cầu phải được người thật xử lý thì một tài
 * khoản không thể gửi hàng trăm yêu cầu rồi bỏ đó.
 */
export const MAX_PENDING_DM_REQUESTS = 5;

/** Nội dung tối đa của `preview` — đủ để quyết định, không tải cả lịch sử. */
const PREVIEW_LENGTH = 200;

interface RequestRow {
  channel_id: string;
  created_at: Date;
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  content: string | null;
  message_count: string;
}

export function profileFromRow(row: {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}): UserProfile {
  return {
    id: row.id as Snowflake,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

/** Kênh này có đang là yêu cầu chờ duyệt không (dùng cho `requestPending`). */
export async function isPendingRequest(pool: Pool, channelId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM dm_requests WHERE channel_id = $1",
    [channelId],
  );
  return result.rowCount === 1;
}

/**
 * Yêu cầu nhắn tin **đang chờ mình duyệt**.
 *
 * Lọc block ngay trong SQL: người đã chặn (một trong hai chiều) không được hiện
 * trong danh sách chờ, nếu không "chặn" chỉ ẩn DM mà vẫn để lối vào khác.
 */
export async function loadMessageRequests(
  pool: Pool,
  userId: string,
): Promise<MessageRequestSummary[]> {
  const result = await pool.query<RequestRow>(
    `SELECT r.channel_id,
            r.created_at,
            u.id,
            u.username,
            u.display_name,
            u.avatar_url,
            last.content,
            (SELECT count(*)::text FROM messages m WHERE m.channel_id = r.channel_id) AS message_count
       FROM dm_requests r
       JOIN users u ON u.id = r.sender_id
       -- Tin mới nhất: dùng LATERAL để index (channel_id, id DESC) phục vụ trực tiếp.
       LEFT JOIN LATERAL (
         SELECT content FROM messages m WHERE m.channel_id = r.channel_id ORDER BY m.id DESC LIMIT 1
       ) last ON true
      WHERE r.recipient_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM relationships rb
           WHERE rb.type = 'blocked'
             AND ((rb.user_id = $1 AND rb.target_id = r.sender_id)
               OR (rb.user_id = r.sender_id AND rb.target_id = $1))
        )
      ORDER BY r.created_at DESC`,
    [userId],
  );

  return result.rows.map((row) => ({
    channelId: row.channel_id as Snowflake,
    sender: profileFromRow(row),
    createdAt: row.created_at.toISOString(),
    preview: row.content === null ? null : [...row.content].slice(0, PREVIEW_LENGTH).join(""),
    messageCount: Number(row.message_count),
  }));
}

/**
 * Xoá yêu cầu đang chờ giữa hai người (nếu có) và trả về các kênh vừa được duyệt.
 *
 * Dùng khi hai người **thành bạn**: bạn bè thì không còn lý do chờ duyệt, và nếu
 * để lại dòng `dm_requests` thì kênh sẽ vĩnh viễn không hiện với người nhận dù
 * đã kết bạn.
 */
export async function clearDmRequestsBetween(
  pool: Pool,
  userA: string,
  userB: string,
): Promise<string[]> {
  const result = await pool.query<{ channel_id: string }>(
    `DELETE FROM dm_requests
      WHERE (sender_id = $1 AND recipient_id = $2)
         OR (sender_id = $2 AND recipient_id = $1)
      RETURNING channel_id`,
    [userA, userB],
  );
  return result.rows.map((row) => row.channel_id);
}

export function registerDmRequestRoutes(app: FastifyInstance, deps: DmRequestDeps): void {
  const { pool, config, publisher, storage } = deps;
  const guard = createAuthGuard(deps.tokens);

  /** Danh sách yêu cầu nhắn tin đang chờ mình duyệt (kèm preview tin mới nhất). */
  app.get("/users/@me/message-requests", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    return reply.send(await loadMessageRequests(pool, userId));
  });

  /**
   * Đồng ý: xoá dấu "chờ duyệt" → kênh trở thành DM bình thường của **cả hai**.
   * Người đồng ý nhận `DM_CHANNEL_CREATE` (các session khác của họ cũng vậy) để
   * DM hiện ra ngay; `visibleChannels` của họ được cấp để nhận fan-out tin nhắn.
   */
  app.post<{ Params: { channelId: string } }>(
    "/users/@me/message-requests/:channelId/accept",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const channelId = request.params.channelId;

      const removed = await pool.query<{ sender_id: string }>(
        "DELETE FROM dm_requests WHERE channel_id = $1 AND recipient_id = $2 RETURNING sender_id",
        [channelId, userId],
      );
      const senderId = removed.rows[0]?.sender_id;
      if (senderId === undefined) throw notFound("Không có yêu cầu nhắn tin này");

      const summary = await loadDmSummary(pool, channelId, userId);
      if (summary === null) throw notFound("Cuộc trò chuyện không tồn tại");

      publisher.grantChannelAccess(channelId, [userId]);
      publisher.publishToUser(userId, "MESSAGE_REQUEST_REMOVE", {
        channelId: channelId as Snowflake,
      });
      publisher.publishToUser(userId, "DM_CHANNEL_CREATE", summary);
      return reply.send(summary);
    },
  );

  /**
   * Từ chối: xoá hẳn cuộc trò chuyện (tin nhắn + tệp đính kèm trên đĩa).
   *
   * Vì sao xoá chứ không chỉ ẩn: người gửi phải biết là không được nhận — nếu
   * kênh vẫn còn trong danh sách của họ thì họ sẽ tiếp tục nhắn vào một khoảng
   * không. Xoá là tín hiệu rõ ràng, và không giữ nội dung của người chưa được
   * phép liên lạc.
   */
  app.post<{ Params: { channelId: string } }>(
    "/users/@me/message-requests/:channelId/decline",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const channelId = request.params.channelId;

      const removed = await pool.query<{ sender_id: string }>(
        "DELETE FROM dm_requests WHERE channel_id = $1 AND recipient_id = $2 RETURNING sender_id",
        [channelId, userId],
      );
      const senderId = removed.rows[0]?.sender_id;
      if (senderId === undefined) throw notFound("Không có yêu cầu nhắn tin này");

      const attachments = await pool.query<{ id: string }>(
        `SELECT a.id FROM attachments a
           JOIN messages m ON m.id = a.message_id
          WHERE m.channel_id = $1`,
        [channelId],
      );
      await pool.query("DELETE FROM channels WHERE id = $1", [channelId]);
      await Promise.all(attachments.rows.map((row) => storage.attachments.remove(row.id)));

      // Người nhận: bỏ kênh khỏi mọi session (kèm CHANNEL_DELETE) + bỏ yêu cầu.
      publisher.revokeChannelAccess(channelId, [userId]);
      publisher.publishToUser(userId, "MESSAGE_REQUEST_REMOVE", {
        channelId: channelId as Snowflake,
      });
      // Người gửi: cuộc trò chuyện biến mất khỏi sidebar của họ.
      publisher.publishToUser(senderId, "CHANNEL_DELETE", {
        id: channelId as Snowflake,
        guildId: null,
      });
      return reply.code(204).send();
    },
  );
}
