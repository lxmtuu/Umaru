import { Permission, createSnowflake, hasPermission, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, conflict, forbidden, notFound, readId, readString } from "../http.js";
import type { TokenService } from "../auth/tokens.js";
import { archiveIdleThreads, loadThread, listThreads } from "./store.js";

/**
 * Thread — luồng thảo luận con của một tin nhắn.
 *
 * Quyền kế thừa từ **kênh cha** một cách tự nhiên: `channels.parent_id` của
 * thread trỏ tới kênh cha, và `loadChannelContext` vốn đã áp overwrite của
 * `parent_id` trước overwrite của chính kênh. Không có bảng quyền riêng, không
 * có nhánh kiểm quyền thứ hai để lệch.
 */
export interface ThreadDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

/** Tên thread lấy từ tin gốc khi người dùng không đặt. */
function deriveName(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim() !== "") ?? "";
  const trimmed = firstLine.trim();
  if (trimmed === "") return "Thread";
  return trimmed.length > 100 ? `${trimmed.slice(0, 99)}…` : trimmed;
}

export function registerThreadRoutes(app: FastifyInstance, deps: ThreadDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);
  const nextId = () => createSnowflake(config.workerId);

  /** Tạo thread từ một tin nhắn (hoặc thread trống nếu không truyền `messageId`). */
  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/threads",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const parentChannelId = request.params.channelId;
      // Cần gửi được tin ở kênh cha mới được mở thread: người chỉ có quyền đọc
      // không nên tạo được chỗ cho người khác viết.
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        parentChannelId,
        Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
      );
      if (context.channel.guild_id === null) throw notFound("Kênh không tồn tại");
      if (context.channel.type === "guild_thread") {
        throw badRequest("Thread không lồng trong thread khác");
      }
      if (context.channel.type !== "guild_text") {
        throw badRequest("Chỉ tạo thread trong kênh văn bản");
      }

      const body = request.body as Record<string, unknown> | undefined;
      const rootMessageId = readId(body, "messageId");
      let name = body?.name === undefined ? null : readString(body, "name", { min: 1, max: 100 });

      if (rootMessageId !== null) {
        const root = await pool.query<{ content: string; channel_id: string }>(
          "SELECT content, channel_id FROM messages WHERE id = $1",
          [rootMessageId],
        );
        const message = root.rows[0];
        if (message === undefined || message.channel_id !== parentChannelId) {
          throw badRequest("messageId phải là tin nhắn trong kênh này");
        }
        const existing = await pool.query(
          "SELECT 1 FROM channel_threads WHERE root_message_id = $1 AND archived_at IS NULL",
          [rootMessageId],
        );
        if (existing.rowCount !== 0) {
          throw conflict("Tin nhắn này đã có thread đang mở");
        }
        name ??= deriveName(message.content);
      }
      name ??= "Thread";

      const channelId = nextId();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO channels (id, guild_id, type, name, parent_id, position)
           VALUES ($1, $2, 'guild_thread', $3, $4, 0)
           RETURNING id`,
          [channelId, context.channel.guild_id, name, parentChannelId],
        );
        if (inserted.rowCount === 0) throw new Error("Không tạo được channel cho thread");
        await client.query(
          `INSERT INTO channel_threads (channel_id, parent_channel_id, root_message_id, owner_id)
           VALUES ($1, $2, $3, $4)`,
          [channelId, parentChannelId, rootMessageId, userId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      // Thành viên đang online phải nhận được tin nhắn trong thread ngay: tính
      // lại `visibleChannels` của các session trong server (một chỗ duy nhất làm
      // việc này, dùng chung với đổi quyền/xoá kênh).
      await publisher.refreshGuildVisibility(context.channel.guild_id);
      const thread = await loadThread(pool, channelId);
      if (thread === null) throw new Error("Không đọc được thread vừa tạo");
      publisher.publishToGuild(context.channel.guild_id, "THREAD_CREATE", thread);
      return reply.code(201).send(thread);
    },
  );

  /** Danh sách thread của kênh; `?archived=1` để xem kho lưu trữ. */
  app.get<{ Params: { channelId: string }; Querystring: { archived?: string } }>(
    "/channels/:channelId/threads",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        request.params.channelId,
        Permission.VIEW_CHANNEL,
      );
      if (context.channel.type === "guild_thread") throw badRequest("Đây đã là thread");
      const archived = request.query.archived === "1" || request.query.archived === "true";

      // Quét lười trước khi trả: thread im lặng quá hạn phải biến khỏi danh sách
      // đang mở ngay lúc người dùng nhìn, không cần cron.
      if (!archived) {
        const archivedIds = await archiveIdleThreads(
          pool,
          request.params.channelId,
          config.threadArchiveMinutes,
        );
        for (const id of archivedIds) {
          const thread = await loadThread(pool, id);
          if (thread !== null) {
            publisher.publishToChannel(request.params.channelId, "THREAD_UPDATE", thread);
          }
        }
      }
      return reply.send(await listThreads(pool, request.params.channelId, { archived }));
    },
  );

  /** Đổi tên / lưu trữ / mở lại. Chủ thread hoặc `MANAGE_CHANNELS`. */
  app.patch<{ Params: { threadId: string } }>(
    "/channels/:threadId/thread",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        request.params.threadId,
        Permission.VIEW_CHANNEL,
      );
      const thread = await loadThread(pool, request.params.threadId);
      if (thread === null) throw notFound("Thread không tồn tại");
      const canManage =
        thread.ownerId === userId || hasPermission(context.permissions, Permission.MANAGE_CHANNELS);
      if (!canManage) throw forbidden("Chỉ chủ thread hoặc người quản lý kênh được đổi");

      const body = request.body as Record<string, unknown> | undefined;
      const name = body?.name === undefined ? null : readString(body, "name", { min: 1, max: 100 });
      const archived = typeof body?.archived === "boolean" ? body.archived : null;
      if (name === null && archived === null) throw badRequest("Không có gì để cập nhật");

      if (name !== null) {
        await pool.query("UPDATE channels SET name = $2, updated_at = now() WHERE id = $1", [
          thread.id,
          name,
        ]);
      }
      if (archived !== null) {
        await pool.query(
          `UPDATE channel_threads
              SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END,
                  last_activity_at = CASE WHEN $2 THEN last_activity_at ELSE now() END
            WHERE channel_id = $1`,
          [thread.id, archived],
        );
      }

      const updated = (await loadThread(pool, thread.id)) ?? thread;
      // Mở lại thread ⇒ phải tính lại visibleChannels để tin mới fan-out tới
      // người đang online; lưu trữ thì ngược lại.
      if (archived !== null) {
        await publisher.refreshGuildVisibility(context.channel.guild_id as string);
      }
      publisher.publishToChannel(updated.parentChannelId, "THREAD_UPDATE", updated);
      return reply.send(updated);
    },
  );

  /** Xoá hẳn thread (kèm tin nhắn) — `MANAGE_CHANNELS` ở kênh cha. */
  app.delete<{ Params: { threadId: string } }>(
    "/channels/:threadId/thread",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const thread = await loadThread(pool, request.params.threadId);
      if (thread === null) throw notFound("Thread không tồn tại");
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        thread.parentChannelId,
        Permission.VIEW_CHANNEL | Permission.MANAGE_CHANNELS,
      );
      // Xoá channel là CASCADE xuống `messages` và `channel_threads`.
      await pool.query("DELETE FROM channels WHERE id = $1", [thread.id]);
      await publisher.refreshGuildVisibility(context.channel.guild_id as string);
      publisher.publishToChannel(thread.parentChannelId, "THREAD_DELETE", {
        id: thread.id,
        parentChannelId: thread.parentChannelId,
      });
      return reply.code(204).send();
    },
  );
}
