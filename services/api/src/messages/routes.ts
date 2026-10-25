import { Permission, createSnowflake, hasPermission, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { HttpError, badRequest, notFound, readId, readLimit, readString } from "../http.js";
import { mapMessage, type MessageRow } from "../mappers.js";
import { syncMessageMentions } from "../mentions.js";

export interface MessageDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

/** Throttle typing: 1 lần/8s/user/channel (spec §7). */
const typingTimestamps = new Map<string, number>();
const TYPING_COOLDOWN_MS = 8_000;

export function registerMessageRoutes(app: FastifyInstance, deps: MessageDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);
  const nextId = () => createSnowflake(config.workerId);

  app.get<{ Params: { channelId: string }; Querystring: { before?: string; limit?: string } }>(
    "/channels/:channelId/messages",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await loadChannelContext(pool, userId as Snowflake, request.params.channelId);

      const limit = readLimit(request.query.limit, 50);
      const before = request.query.before ?? null;
      if (before !== null && !/^\d{1,20}$/.test(before)) {
        throw badRequest("before phải là snowflake");
      }

      const result = await pool.query<MessageRow>(
        `SELECT id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at
           FROM messages
          WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
          ORDER BY id DESC
          LIMIT $3`,
        [request.params.channelId, before, limit],
      );
      return reply.send(result.rows.map(mapMessage));
    },
  );

  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/messages",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await loadChannelContext(
        pool,
        userId as Snowflake,
        request.params.channelId,
        Permission.SEND_MESSAGES,
      );

      const body = request.body as Record<string, unknown> | undefined;
      const content = readString(body, "content", { min: 1, max: 2000, trim: false });
      const replyToId = readId(body, "replyToId");
      if (replyToId !== null) {
        const parent = await pool.query<{ channel_id: string }>(
          "SELECT channel_id FROM messages WHERE id = $1",
          [replyToId],
        );
        if (parent.rows[0]?.channel_id !== request.params.channelId) {
          throw badRequest("replyToId phải là tin nhắn trong cùng kênh");
        }
      }

      const id = nextId();
      const inserted = await pool.query<MessageRow>(
        `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at`,
        [id, request.params.channelId, userId, content, replyToId],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Không đọc được message vừa tạo");
      const message = mapMessage(row);

      // @mention ghi ngay lúc gửi để badge tính được bằng một câu SQL.
      await syncMessageMentions(pool, message.id as string, request.params.channelId, content);

      publisher.publishToChannel(request.params.channelId, "MESSAGE_CREATE", message);
      return reply.code(201).send(message);
    },
  );

  app.patch<{ Params: { messageId: string } }>(
    "/messages/:messageId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const message = await loadMessage(pool, request.params.messageId);
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        message.channel_id,
        Permission.SEND_MESSAGES,
      );
      if (message.author_id !== userId && !hasPermission(context.permissions, Permission.MANAGE_MESSAGES)) {
        throw new HttpError(403, "FORBIDDEN", "Chỉ sửa được tin nhắn của mình");
      }

      const body = request.body as Record<string, unknown> | undefined;
      const content = readString(body, "content", { min: 1, max: 2000, trim: false });
      const updated = await pool.query<MessageRow>(
        `UPDATE messages SET content = $2, edited_at = now()
          WHERE id = $1
          RETURNING id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at`,
        [message.id, content],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("Tin nhắn không tồn tại");
      // Sửa nội dung → mention cũ sai, ghi lại từ đầu.
      await syncMessageMentions(pool, row.id as string, row.channel_id as string, content);

      publisher.publishToChannel(row.channel_id, "MESSAGE_UPDATE", {
        id: row.id as Snowflake,
        channelId: row.channel_id as Snowflake,
        content: row.content,
        editedAt: row.edited_at === null ? null : row.edited_at.toISOString(),
      });
      return reply.send(mapMessage(row));
    },
  );

  app.delete<{ Params: { messageId: string } }>(
    "/messages/:messageId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const message = await loadMessage(pool, request.params.messageId);
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        message.channel_id,
        Permission.VIEW_CHANNEL,
      );
      if (message.author_id !== userId && !hasPermission(context.permissions, Permission.MANAGE_MESSAGES)) {
        throw new HttpError(403, "FORBIDDEN", "Chỉ xoá được tin nhắn của mình");
      }
      await pool.query("DELETE FROM messages WHERE id = $1", [message.id]);
      publisher.publishToChannel(message.channel_id, "MESSAGE_DELETE", {
        id: message.id as Snowflake,
        channelId: message.channel_id as Snowflake,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/typing",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await loadChannelContext(pool, userId as Snowflake, request.params.channelId);

      const key = `${userId}:${request.params.channelId}`;
      const now = Date.now();
      const last = typingTimestamps.get(key) ?? 0;
      if (now - last < TYPING_COOLDOWN_MS) {
        const retryAfter = Math.ceil((TYPING_COOLDOWN_MS - (now - last)) / 1000);
        return reply.code(429).send({
          error: { code: "RATE_LIMITED", message: "Gửi typing quá nhanh" },
          retry_after: retryAfter,
        });
      }
      typingTimestamps.set(key, now);
      publisher.publishToChannel(request.params.channelId, "TYPING_START", {
        channelId: request.params.channelId as Snowflake,
        userId: userId as Snowflake,
        timestamp: now,
      });
      return reply.code(204).send();
    },
  );
}

async function loadMessage(pool: Pool, messageId: string): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    `SELECT id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at
       FROM messages WHERE id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound("Tin nhắn không tồn tại");
  return row;
}
