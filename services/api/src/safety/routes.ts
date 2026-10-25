import {
  createSnowflake,
  type GuildMemberSummary,
  type ReportReason,
  type ReportResult,
  type Snowflake,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { badRequest, forbidden, notFound, readId, readOptionalString } from "../http.js";
import { isBlockedBetween } from "../blocks.js";

export interface SafetyDeps {
  pool: Pool;
  tokens: TokenService;
  config: Config;
}

/** Số báo cáo tối đa một người được gửi trong 1 giờ (chống spam report). */
export const REPORT_HOURLY_LIMIT = 20;
/** Độ dài tối đa phần mô tả thêm. */
const MAX_DETAILS = 1000;

export const REPORT_REASONS: readonly ReportReason[] = [
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "violence",
  "self_harm",
  "impersonation",
  "other",
];

interface BlockedUserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

/**
 * Chặn / bỏ chặn + báo cáo vi phạm.
 *
 * Block dùng bảng `relationships` (đã có sẵn `type='blocked'`); hành vi hiệu lực
 * hai chiều được mô tả trong `blocks.ts`.
 */
export function registerSafetyRoutes(app: FastifyInstance, deps: SafetyDeps): void {
  const { pool, config } = deps;
  const guard = createAuthGuard(deps.tokens);

  /** Danh sách người tôi đã chặn (mới nhất trước) — để có chỗ bỏ chặn. */
  app.get("/users/@me/blocks", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const result = await pool.query<BlockedUserRow>(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
         FROM relationships r
         JOIN users u ON u.id = r.target_id
        WHERE r.user_id = $1 AND r.type = 'blocked'
        ORDER BY r.created_at DESC`,
      [userId],
    );
    const items: GuildMemberSummary[] = result.rows.map((row) => ({
      userId: row.id as Snowflake,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      roleIds: [],
    }));
    return reply.send(items);
  });

  /**
   * Chặn một người. Idempotent: chặn lại người đã chặn vẫn 204.
   *
   * Chặn cũng cắt quan hệ bạn bè/lời mời đang có giữa hai người (cả hai chiều):
   * để nguyên `friend` trong khi đã `blocked` là dữ liệu tự mâu thuẫn.
   */
  app.put<{ Params: { userId: string } }>(
    "/users/@me/blocks/:userId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const targetId = request.params.userId;
      if (targetId === userId) throw badRequest("Không thể tự chặn chính mình");

      const exists = await pool.query("SELECT 1 FROM users WHERE id = $1", [targetId]);
      if (exists.rowCount === 0) throw notFound("Người dùng không tồn tại");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'blocked')
           ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'blocked', created_at = now()`,
          [userId, targetId],
        );
        // Cắt bạn bè / lời mời chờ giữa hai người.
        await client.query(
          `DELETE FROM relationships
            WHERE type <> 'blocked'
              AND ((user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1))`,
          [userId, targetId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/users/@me/blocks/:userId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await pool.query(
        "DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND type = 'blocked'",
        [userId, request.params.userId],
      );
      return reply.code(204).send();
    },
  );

  /**
   * Gửi báo cáo. Hoặc `messageId` (báo cáo một tin) hoặc `userId` (báo cáo người).
   *
   * Tin phải xem được (kiểm `VIEW_CHANNEL`) — nếu không, người dùng có thể dùng
   * endpoint này để dò id tin trong kênh riêng tư. Nội dung được **sao lưu** vào
   * báo cáo để xoá/sửa tin sau đó không làm mất bằng chứng.
   */
  app.post("/reports", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown> | undefined;

    const rawReason = readOptionalString(body, "reason", { max: 32 }) ?? "";
    if (!REPORT_REASONS.includes(rawReason as ReportReason)) {
      throw badRequest(`"reason" phải là một trong: ${REPORT_REASONS.join(", ")}`);
    }
    const reason = rawReason as ReportReason;
    const details = readOptionalString(body, "details", { max: MAX_DETAILS }) ?? null;

    const messageId = readId(body, "messageId");
    const targetUserId = readId(body, "userId");
    if ((messageId === null) === (targetUserId === null)) {
      throw badRequest("Cần đúng một trong hai: messageId (báo cáo tin) hoặc userId (báo cáo người)");
    }

    // Chống lạm dụng: giới hạn số báo cáo mỗi giờ.
    const recent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reports
        WHERE reporter_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId],
    );
    if (Number(recent.rows[0]?.count ?? "0") >= REPORT_HOURLY_LIMIT) {
      throw forbidden(`Bạn đã gửi quá ${REPORT_HOURLY_LIMIT} báo cáo trong một giờ. Thử lại sau.`);
    }

    let resolvedTarget = targetUserId;
    let channelId: string | null = null;
    let guildId: string | null = null;
    let snapshot: string | null = null;

    if (messageId !== null) {
      const message = await pool.query<{
        author_id: string;
        content: string;
        channel_id: string;
        guild_id: string | null;
      }>(
        `SELECT m.author_id, m.content, m.channel_id, c.guild_id
           FROM messages m JOIN channels c ON c.id = m.channel_id
          WHERE m.id = $1`,
        [messageId],
      );
      const row = message.rows[0];
      if (row === undefined) throw notFound("Tin nhắn không tồn tại");
      // Không xem được kênh → 404 (không lộ tin nằm ở đâu).
      await loadChannelContext(pool, userId as Snowflake, row.channel_id);

      resolvedTarget = row.author_id;
      channelId = row.channel_id;
      guildId = row.guild_id;
      snapshot = row.content.slice(0, 2000);
    }

    if (resolvedTarget === null) throw badRequest("Thiếu người bị báo cáo");
    if (resolvedTarget === userId) throw badRequest("Không thể tự báo cáo chính mình");

    const exists = await pool.query("SELECT 1 FROM users WHERE id = $1", [resolvedTarget]);
    if (exists.rowCount === 0) throw notFound("Người dùng không tồn tại");

    const id = createSnowflake(config.workerId);
    const inserted = await pool.query<{ created_at: Date; status: string }>(
      `INSERT INTO reports (id, reporter_id, target_user_id, target_message_id, channel_id,
                            guild_id, reason, details, snapshot_content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING created_at, status`,
      [
        id,
        userId,
        resolvedTarget,
        messageId,
        channelId,
        guildId,
        reason,
        details,
        snapshot,
      ],
    );

    const report: ReportResult = {
      id: id as Snowflake,
      status: "open",
      createdAt: (inserted.rows[0]?.created_at ?? new Date()).toISOString(),
    };
    return reply.code(201).send(report);
  });

  /** Báo cáo người: chặn luôn hay không do client quyết định (2 lời gọi riêng). */
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/blocked",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const blocked = await isBlockedBetween(pool, userId, request.params.userId);
      return reply.send({ blocked });
    },
  );
}
