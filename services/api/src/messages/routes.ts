import { Permission, createSnowflake, hasPermission, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadChannelContext } from "../access.js";
import { isDmBlocked } from "../blocks.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import {
  HttpError,
  badRequest,
  forbidden,
  notFound,
  readId,
  readLimit,
  readString,
} from "../http.js";
import { attachmentUrl, mapMessagesWithAttachments } from "../attachments.js";
import {
  MAX_REACTIONS_PER_MESSAGE,
  countDistinctReactions,
  normalizeEmoji,
  reactionsForMessage,
} from "../reactions.js";
import { mapMessage, type MessageRow } from "../mappers.js";
import { BucketStore, rateLimitedBody } from "../rateLimit.js";
import { syncMessageMentions } from "../mentions.js";
import {
  isAllowedMime,
  MAX_FILES_PER_MESSAGE,
  sanitizeFilename,
  type FileStore,
  type Stores,
} from "../uploads/storage.js";
import { HEADER_BYTES, isImageMime, readImageSize } from "../uploads/imageSize.js";
import type { PushSender } from "../push/sender.js";
import type { LinkEmbedResolver } from "../embeds/resolver.js";
import { decrementThreadMessages, isThreadArchived, touchThread } from "../threads/store.js";

export interface MessageDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
  /** Thông báo đẩy khi người nhận đã đóng tab; bỏ trống = không đẩy. */
  push?: PushSender;
  /** Kho tệp đính kèm/avatar (đĩa cục bộ hoặc S3/R2 — xem `createStores`). */
  storage: Stores;
  /** Dựng thẻ xem trước liên kết; bỏ trống = tắt (test cũ, hoặc `EMBEDS=off`). */
  embeds?: LinkEmbedResolver;
}

/** Trần số tin ghim mỗi kênh — giống Discord; chặn phình danh sách ghim. */
export const MAX_PINS_PER_CHANNEL = 50;

/**
 * Còn bao nhiêu giây nữa người này mới được gửi tin tiếp theo (slowmode).
 *
 * Trả **0** khi không phải chờ: kênh không bật slowmode, là DM, hoặc người gửi
 * có `MANAGE_MESSAGES`/`MANAGE_CHANNELS` (người trực kênh cần nói nhiều; áp cả
 * họ thì slowmode thành công cụ tự khoá mình).
 *
 * Thread dùng slowmode của **kênh cha**: nếu không, mở thread là cách né đồng hồ
 * trong một cú bấm.
 */
async function slowmodeWaitSeconds(
  pool: Pool,
  options: {
    channelId: string;
    channel: { type: string; parent_id: string | null; slowmode_seconds: number };
    userId: string;
    permissions: bigint;
  },
): Promise<number> {
  const { channelId, channel, userId, permissions } = options;
  if (hasPermission(permissions, Permission.MANAGE_MESSAGES)) return 0;
  if (hasPermission(permissions, Permission.MANAGE_CHANNELS)) return 0;

  let slowmode = channel.slowmode_seconds;
  if (channel.type === "guild_thread" && channel.parent_id !== null) {
    const parent = await pool.query<{ slowmode_seconds: number }>(
      "SELECT slowmode_seconds FROM channels WHERE id = $1",
      [channel.parent_id],
    );
    slowmode = parent.rows[0]?.slowmode_seconds ?? 0;
  }
  if (slowmode <= 0) return 0;

  const last = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM messages
      WHERE channel_id = $1 AND author_id = $2
      ORDER BY id DESC
      LIMIT 1`,
    [channelId, userId],
  );
  const lastAt = last.rows[0]?.created_at;
  if (lastAt === undefined) return 0;
  const elapsed = (Date.now() - lastAt.getTime()) / 1000;
  return elapsed >= slowmode ? 0 : Math.ceil(slowmode - elapsed);
}

/** Throttle typing: 1 lần/8s/user/channel (spec §7). */
const typingTimestamps = new Map<string, number>();
const TYPING_COOLDOWN_MS = 8_000;

export function registerMessageRoutes(app: FastifyInstance, deps: MessageDeps): void {
  const { pool, config, publisher, push, storage, embeds } = deps;
  const guard = createAuthGuard(deps.tokens);
  const nextId = () => createSnowflake(config.workerId);

  /**
   * Rate limit gửi tin (spec §7): 5 tin/5s cho **một người trong một kênh** và
   * 30 tin/phút cho **cả kênh**. Hai bucket độc lập: người bình thường không bao
   * giờ chạm trần kênh, còn kênh bị spam bởi nhiều tài khoản thì trần kênh mới
   * là thứ cứu server.
   */
  const messageUserBuckets = new BucketStore(config.rateLimitMessagesPerUser, 5_000);
  const messageChannelBuckets = new BucketStore(config.rateLimitMessagesPerChannel, 60_000);

  app.get<{ Params: { channelId: string }; Querystring: { before?: string; limit?: string } }>(
    "/channels/:channelId/messages",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await loadChannelContext(pool, userId as Snowflake, request.params.channelId);

      // DM giữa hai người đã chặn nhau: coi như không còn lịch sử để đọc.
      if (await isDmBlocked(pool, request.params.channelId, userId)) return reply.send([]);

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
      return reply.send(await mapMessagesWithAttachments(pool, result.rows, userId));
    },
  );

  /**
   * Gửi tin. Nhận **cả** `application/json` (text thuần) và `multipart/form-data`
   * (text + file đính kèm) trên cùng một đường dẫn: JSON giữ nguyên như trước,
   * multipart cho phép gửi kèm tới 4 file ≤ 10MB. Tin chỉ có file (không text)
   * cũng hợp lệ.
   */
  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/messages",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channelId } = request.params;
      const context = await loadChannelContext(
        pool,
        userId as Snowflake,
        channelId,
        Permission.SEND_MESSAGES,
      );
      if (await isDmBlocked(pool, channelId, userId)) {
        throw forbidden("Không thể nhắn tin với người này");
      }

      // Kiểm **trước** khi đọc multipart/ghi đĩa: bị chặn thì không phát dispatch
      // và không để lại tệp mồ côi.
      if (config.rateLimitsEnabled) {
        const perUser = messageUserBuckets.take(`${userId}:${channelId}`);
        if (perUser !== null) {
          return reply
            .code(429)
            .send(rateLimitedBody(perUser, "Bạn gửi tin quá nhanh, thử lại sau vài giây"));
        }
        const perChannel = messageChannelBuckets.take(channelId);
        if (perChannel !== null) {
          return reply
            .code(429)
            .send(rateLimitedBody(perChannel, "Kênh này nhận quá nhiều tin, thử lại sau"));
        }
      }

      const payload = request.isMultipart()
        ? await readMultipartMessage(request, config, storage.attachments)
        : readJsonMessage(request.body);

      if (payload.content.trim().length === 0 && payload.files.length === 0) {
        throw badRequest('Thiếu trường "content" (hoặc đính kèm tệp)');
      }
      if (payload.replyToId !== null) {
        const parent = await pool.query<{ channel_id: string }>(
          "SELECT channel_id FROM messages WHERE id = $1",
          [payload.replyToId],
        );
        if (parent.rows[0]?.channel_id !== channelId) {
          throw badRequest("replyToId phải là tin nhắn trong cùng kênh");
        }
      }

      // Thread đã lưu trữ chỉ đọc: phải mở lại trước khi viết, nếu không
      // "lưu trữ" chỉ là nhãn trang trí.
      if ((await isThreadArchived(pool, channelId)) === true) {
        throw new HttpError(403, "THREAD_ARCHIVED", "Thread đã lưu trữ — mở lại để gửi tin");
      }

      // Slowmode — kiểm **trước** khi đọc multipart để không ghi tệp mồ côi.
      if (config.rateLimitsEnabled) {
        const wait = await slowmodeWaitSeconds(pool, {
          channelId,
          channel: context.channel,
          userId,
          permissions: context.permissions | (context.guild?.permissions ?? 0n),
        });
        if (wait > 0) {
          return reply
            .code(429)
            .send(
              rateLimitedBody(wait, `Kênh đang bật slowmode — còn ${wait} giây nữa mới gửi tiếp`),
            );
        }
      }

      const id = nextId();
      const client = await pool.connect();
      let row: MessageRow;
      try {
        await client.query("BEGIN");
        const inserted = await client.query<MessageRow>(
          `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at`,
          [id, channelId, userId, payload.content, payload.replyToId],
        );
        const created = inserted.rows[0];
        if (created === undefined) throw new Error("Không đọc được message vừa tạo");
        row = created;

        for (const file of payload.files) {
          await client.query(
            `INSERT INTO attachments
               (id, message_id, filename, url, size, mime_type, width, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              file.id,
              id,
              file.filename,
              attachmentUrl(file.id),
              file.size,
              file.mimeType,
              file.width,
              file.height,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        // Ghi DB lỗi thì xoá luôn file vừa ghi để không rác đĩa.
        await Promise.all(payload.files.map((file) => storage.attachments.remove(file.id)));
        throw error;
      } finally {
        client.release();
      }

      const message = mapMessage(row);
      message.attachments = payload.files.map((file) => ({
        id: file.id as Snowflake,
        filename: file.filename,
        url: attachmentUrl(file.id),
        size: file.size,
        mimeType: file.mimeType,
        width: file.width,
        height: file.height,
      }));

      // @mention ghi ngay lúc gửi để badge tính được bằng một câu SQL.
      await syncMessageMentions(pool, message.id as string, channelId, payload.content);
      // Có tin mới trong thread ⇒ đếm tin + dời mốc hoạt động (no-op với kênh
      // thường, chỉ là một lần tra PK).
      await touchThread(pool, channelId);

      publisher.publishToChannel(channelId, "MESSAGE_CREATE", message);

      // Embed tới sau bằng `MESSAGE_UPDATE`: tải trang bên ngoài không được làm
      // chậm việc gửi tin (xem `embeds/resolver.ts`).
      embeds?.enqueue(message.id as string, channelId, payload.content);

      /**
       * Thông báo đẩy cho người **đã đóng tab**. Chỉ tra tên tác giả khi push
       * được cấu hình — chưa cấu hình thì đường gửi tin không thêm truy vấn nào.
       *
       * Cố ý không `await`: một dịch vụ push chậm không được làm chậm việc gửi
       * tin, và `notifyMessage` đã tự nuốt lỗi.
       */
      if (push?.enabled === true) {
        const author = await pool.query<{ display_name: string }>(
          "SELECT display_name FROM users WHERE id = $1",
          [userId],
        );
        void push.notifyMessage({
          messageId: message.id as string,
          channelId,
          authorId: userId,
          authorName: author.rows[0]?.display_name ?? "Ai đó",
          // DM không có tên kênh có nghĩa với người nhận — tiêu đề chỉ là tên người gửi.
          channelLabel: context.channel.guild_id === null ? null : context.channel.name,
          content: payload.content,
          attachmentCount: payload.files.length,
          isDm: context.channel.guild_id === null,
        });
      }
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
      const [updatedMessage] = await mapMessagesWithAttachments(pool, [row], userId);
      // Nội dung đổi thì link có thể đổi theo → xoá thẻ cũ, dựng lại.
      if (embeds !== undefined) {
        await embeds.refresh(row.id as string, row.channel_id as string, content);
      }
      return reply.send(updatedMessage);
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
      // Lấy id attachment trước khi xoá: file trên đĩa không tự CASCADE theo DB.
      const attachments = await pool.query<{ id: string }>(
        "SELECT id FROM attachments WHERE message_id = $1",
        [message.id],
      );
      await pool.query("DELETE FROM messages WHERE id = $1", [message.id]);
      await decrementThreadMessages(pool, message.channel_id);
      await Promise.all(attachments.rows.map((row) => storage.attachments.remove(row.id)));
      publisher.publishToChannel(message.channel_id, "MESSAGE_DELETE", {
        id: message.id as Snowflake,
        channelId: message.channel_id as Snowflake,
      });
      return reply.code(204).send();
    },
  );

  /**
   * Danh sách tin đã ghim của kênh (mới ghim trước).
   *
   * Chỉ cần `VIEW_CHANNEL` (ai đọc được lịch sử kênh thì xem được ghim), và DM
   * bị chặn thì trả rỗng — cùng quy tắc với danh sách tin.
   */
  app.get<{ Params: { channelId: string }; Querystring: { limit?: string } }>(
    "/channels/:channelId/pins",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await loadChannelContext(pool, userId as Snowflake, request.params.channelId);
      if (await isDmBlocked(pool, request.params.channelId, userId)) return reply.send([]);

      const limit = readLimit(request.query.limit, MAX_PINS_PER_CHANNEL);
      const result = await pool.query<MessageRow>(
        `SELECT id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at
           FROM messages
          WHERE channel_id = $1 AND pinned
          ORDER BY id DESC
          LIMIT $2`,
        [request.params.channelId, limit],
      );
      return reply.send(await mapMessagesWithAttachments(pool, result.rows, userId));
    },
  );

  /** Ghim một tin. Idempotent: ghim lại tin đã ghim vẫn 200. */
  app.put<{ Params: { messageId: string } }>(
    "/messages/:messageId/pin",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const message = await loadMessage(pool, request.params.messageId);
      // DM: hai người trong cuộc đều ghim được (giống Discord). Server: cần
      // MANAGE_MESSAGES, nếu không thì 403 rõ ràng thay vì im lặng.
      const context = await loadChannelContext(pool, userId as Snowflake, message.channel_id);
      if (context.guild !== null && !hasPermission(context.permissions, Permission.MANAGE_MESSAGES)) {
        throw forbidden("Cần quyền quản lý tin nhắn để ghim");
      }
      if (await isDmBlocked(pool, message.channel_id, userId)) {
        throw forbidden("Không thể ghim tin trong cuộc trò chuyện này");
      }

      if (!message.pinned) {
        const count = await pool.query<{ total: string }>(
          "SELECT count(*)::text AS total FROM messages WHERE channel_id = $1 AND pinned",
          [message.channel_id],
        );
        if (Number(count.rows[0]?.total ?? "0") >= MAX_PINS_PER_CHANNEL) {
          throw badRequest(
            `Kênh đã có ${MAX_PINS_PER_CHANNEL} tin ghim — bỏ ghim bớt trước khi ghim thêm`,
          );
        }
      }

      const updated = await pool.query<MessageRow>(
        `UPDATE messages SET pinned = true
          WHERE id = $1
          RETURNING id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at`,
        [message.id],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("Tin nhắn không tồn tại");

      // Ghim lại tin đã ghim không phát lại event (tránh nhiễu cho client).
      if (!message.pinned) {
        publisher.publishToChannel(row.channel_id, "MESSAGE_PIN_UPDATE", {
          id: row.id as Snowflake,
          channelId: row.channel_id as Snowflake,
          pinned: true,
        });
      }
      const [pinned] = await mapMessagesWithAttachments(pool, [row], userId);
      return reply.send(pinned);
    },
  );

  /** Bỏ ghim. Idempotent: bỏ ghim tin chưa ghim vẫn 200. */
  app.delete<{ Params: { messageId: string } }>(
    "/messages/:messageId/pin",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const message = await loadMessage(pool, request.params.messageId);
      // Cùng quy tắc với ghim: DM ai trong cuộc cũng được, server cần MANAGE_MESSAGES.
      const context = await loadChannelContext(pool, userId as Snowflake, message.channel_id);
      if (context.guild !== null && !hasPermission(context.permissions, Permission.MANAGE_MESSAGES)) {
        throw forbidden("Cần quyền quản lý tin nhắn để bỏ ghim");
      }

      const updated = await pool.query<MessageRow>(
        `UPDATE messages SET pinned = false
          WHERE id = $1
          RETURNING id, channel_id, author_id, content, reply_to_id, pinned, created_at, edited_at`,
        [message.id],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("Tin nhắn không tồn tại");

      if (message.pinned) {
        publisher.publishToChannel(row.channel_id, "MESSAGE_PIN_UPDATE", {
          id: row.id as Snowflake,
          channelId: row.channel_id as Snowflake,
          pinned: false,
        });
      }
      const [unpinned] = await mapMessagesWithAttachments(pool, [row], userId);
      return reply.send(unpinned);
    },
  );

  /**
   * Thả / bỏ reaction trên một tin.
   *
   * Một cặp `PUT`/`DELETE` với emoji nằm trong đường dẫn (client
   * `encodeURIComponent`) thay cho `POST …/reactions` kèm body: URL nói rõ thao
   * tác, gọi lại nhiều lần vẫn ra cùng kết quả (khoá chính ba cột ở bảng
   * `message_reactions`), và không phải lo proxy nào đó bỏ body của `DELETE`.
   *
   * Quyền: đọc được kênh chứa tin là thả được (giống Discord) — không cần
   * `SEND_MESSAGES`, vì thả reaction vào tin cũ trong kênh chỉ-đọc vẫn hợp lý.
   * DM bị chặn thì không thả được, cùng quy tắc với gửi tin.
   */
  async function changeReaction(
    request: FastifyRequest<{ Params: { messageId: string; emoji: string } }>,
    reply: FastifyReply,
    added: boolean,
  ) {
    const userId = requireUserId(request);
    const message = await loadMessage(pool, request.params.messageId);
    await loadChannelContext(pool, userId as Snowflake, message.channel_id, Permission.VIEW_CHANNEL);
    if (await isDmBlocked(pool, message.channel_id, userId)) {
      throw forbidden("Không thể thả cảm xúc trong cuộc trò chuyện này");
    }
    // Fastify đã giải mã `%F0%9F%91%8D` trong đường dẫn thành ký tự thật.
    const emoji = normalizeEmoji(request.params.emoji);
    let changed: { rowCount: number | null };

    if (added) {
      // Trần chỉ áp cho emoji **mới**: người dùng đã thả emoji này rồi thì thả
      // lại không đẩy số emoji khác nhau lên, không được chặn.
      const mine = await pool.query(
        `SELECT 1 FROM message_reactions
          WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [message.id, userId, emoji],
      );
      if (mine.rowCount === 0) {
        const distinct = await countDistinctReactions(pool, message.id);
        if (distinct >= MAX_REACTIONS_PER_MESSAGE) {
          throw badRequest(`Mỗi tin tối đa ${MAX_REACTIONS_PER_MESSAGE} emoji khác nhau`);
        }
      }
      changed = await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [message.id, userId, emoji],
      );
    } else {
      changed = await pool.query(
        "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
        [message.id, userId, emoji],
      );
    }

    // Thao tác lặp (thả emoji đã thả, bỏ emoji chưa thả) không đổi gì trong DB
    // thì **không phát event**: route vẫn 200 (idempotent) nhưng không làm mọi
    // client trong kênh phải render lại một lần vô ích.
    const state = { reactions: await reactionsForMessage(pool, message.id, userId) };
    if (changed.rowCount === 0) return reply.send(state);

    // `count` gửi đi là **số tuyệt đối**, không phải `+1`: delta tương đối sẽ
    // lệch ngay khi hai người thả cùng lúc và một tab bỏ lỡ event.
    const totals = await pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM message_reactions WHERE message_id = $1 AND emoji = $2",
      [message.id, emoji],
    );
    publisher.publishToChannel(message.channel_id, "MESSAGE_REACTION_UPDATE", {
      messageId: message.id as Snowflake,
      channelId: message.channel_id as Snowflake,
      emoji,
      count: Number(totals.rows[0]?.total ?? "0"),
      userId: userId as Snowflake,
      added,
    });

    return reply.send(state);
  }

  app.put<{ Params: { messageId: string; emoji: string } }>(
    "/messages/:messageId/reactions/:emoji",
    { preHandler: guard },
    async (request, reply) => changeReaction(request, reply, true),
  );

  app.delete<{ Params: { messageId: string; emoji: string } }>(
    "/messages/:messageId/reactions/:emoji",
    { preHandler: guard },
    async (request, reply) => changeReaction(request, reply, false),
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
        return reply.code(429).send(rateLimitedBody(retryAfter, "Gửi typing quá nhanh"));
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

interface PendingFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
}

interface MessagePayload {
  content: string;
  replyToId: string | null;
  files: PendingFile[];
}

/** Thân JSON cũ: chỉ text (+ reply), không kèm file. */
function readJsonMessage(body: unknown): MessagePayload {
  const record = body as Record<string, unknown> | undefined;
  return {
    content: readString(record, "content", { min: 1, max: 2000, trim: false }),
    replyToId: readId(record, "replyToId"),
    files: [],
  };
}

/**
 * Đọc multipart: field `content`/`replyToId` + các part file tên bất kỳ.
 * Ghi file ra đĩa ngay khi nhận; lỗi giữa đường thì dọn những file đã ghi.
 */
async function readMultipartMessage(
  request: FastifyRequest,
  config: Config,
  store: FileStore,
): Promise<MessagePayload> {
  const payload: MessagePayload = { content: "", replyToId: null, files: [] };

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const mimeType = (part.mimetype || "application/octet-stream").toLowerCase();
        if (!isAllowedMime(mimeType)) {
          part.file.resume();
          throw new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            `Định dạng ${mimeType} không được phép tải lên`,
          );
        }
        if (payload.files.length >= MAX_FILES_PER_MESSAGE) {
          part.file.resume();
          throw badRequest(`Mỗi tin nhắn tối đa ${MAX_FILES_PER_MESSAGE} tệp`);
        }

        const id = createSnowflake(config.workerId);
        const size = await store.write(id, part.file, config.maxUploadBytes, {
          contentType: mimeType,
        });
        if (part.file.truncated) {
          await store.remove(id);
          throw new HttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Tệp vượt quá ${Math.floor(config.maxUploadBytes / (1024 * 1024))}MB`,
          );
        }

        let width: number | null = null;
        let height: number | null = null;
        if (isImageMime(mimeType)) {
          const header = await store.peek(id, HEADER_BYTES);
          const dimensions = readImageSize(header);
          width = dimensions?.width ?? null;
          height = dimensions?.height ?? null;
        }

        payload.files.push({
          id,
          filename: sanitizeFilename(part.filename),
          mimeType,
          size,
          width,
          height,
        });
        continue;
      }

      const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
      if (part.fieldname === "content") {
        if ([...value].length > 2000) {
          throw badRequest('"content" phải dài 1–2000 ký tự');
        }
        payload.content = value;
      } else if (part.fieldname === "replyToId" && value.trim().length > 0) {
        if (!/^\d{1,20}$/.test(value.trim())) {
          throw badRequest('"replyToId" phải là snowflake (chuỗi số)');
        }
        payload.replyToId = value.trim();
      }
    }
  } catch (error) {
    await Promise.all(payload.files.map((file) => store.remove(file.id)));
    throw error;
  }

  return payload;
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
