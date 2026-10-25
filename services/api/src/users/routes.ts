import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createSnowflake, type UserProfile } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { HttpError, badRequest, notFound } from "../http.js";
import { avatarUrl, isAvatarMime } from "../avatars.js";
import { mapUser, type UserRow } from "../mappers.js";
import { HEADER_BYTES, detectImageMime, readImageSize } from "../uploads/imageSize.js";
import {
  ensureUploadsDir,
  readUpload,
  readUploadHeader,
  removeUpload,
  uploadSize,
} from "../uploads/storage.js";

export interface UserDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

interface AvatarRow {
  user_id: string;
  upload_id: string;
  mime_type: string;
}


/**
 * Avatar: tải lên, xoá, và phục vụ ảnh.
 *
 * Quyền xem ảnh: mọi người dùng **đã đăng nhập** đều xem được avatar của nhau
 * (giống cách avatar hiện trong khung chat). Không đặt token vào URL nên client
 * tải bằng fetch + Bearer rồi dựng blob URL — cùng cơ chế với tệp đính kèm.
 */
export function registerUserRoutes(app: FastifyInstance, deps: UserDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);

  /**
   * Phát `USER_UPDATE` tới mọi server mà người này là thành viên, và tới các
   * session của chính họ (nhiều tab/thiết bị).
   */
  const broadcastUser = async (row: UserRow): Promise<void> => {
    // Chỉ gửi phần hồ sơ: presence là trạng thái ephemeral, không được bịa
    // "online" ở đây (client sẽ tự bỏ qua nếu trường không có).
    const user: UserProfile = {
      id: row.id as UserProfile["id"],
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    };
    const guilds = await pool.query<{ guild_id: string }>(
      "SELECT guild_id FROM guild_members WHERE user_id = $1",
      [user.id],
    );
    for (const row of guilds.rows) {
      publisher.publishToGuild(row.guild_id, "USER_UPDATE", { user });
    }
    publisher.publishToUser(user.id, "USER_UPDATE", { user });
  };

  /** Ảnh đang phục vụ — URL chứa uploadId nên cache được vĩnh viễn. */
  app.get<{ Params: { userId: string; uploadId: string } }>(
    "/users/:userId/avatar/:uploadId",
    { preHandler: guard },
    async (request, reply) => {
      const { userId, uploadId } = request.params;
      const result = await pool.query<AvatarRow>(
        "SELECT user_id, upload_id, mime_type FROM user_avatars WHERE user_id = $1",
        [userId],
      );
      const row = result.rows[0];
      // URL cũ sau khi đổi avatar (id khác) → 404, không trả ảnh mới dưới URL cũ.
      if (row === undefined || row.upload_id !== uploadId) throw notFound("Ảnh không tồn tại");

      const size = await uploadSize(config.avatarsDir, uploadId);
      if (size === null) throw notFound("Ảnh không tồn tại");

      return reply
        .code(200)
        .header("content-type", row.mime_type)
        .header("content-length", String(size))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("etag", `"${uploadId}"`)
        .send(readUpload(config.avatarsDir, uploadId));
    },
  );

  /**
   * Tải avatar mới (`multipart/form-data`, một trường file bất kỳ).
   *
   * Kiểm ba lớp: MIME khai báo, **header ảnh thật** (đọc magic bytes), và kích
   * thước. File cũ bị xoá **sau khi** commit DB thành công — lỗi giữa đường
   * không làm mất avatar đang dùng.
   */
  app.put("/users/@me/avatar", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    if (!request.isMultipart()) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần gửi multipart/form-data");
    }

    let uploadId: string | null = null;
    let mimeType = "";
    let size = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        if (uploadId !== null) {
          part.file.resume();
          throw badRequest("Chỉ nhận một ảnh mỗi lần");
        }

        const declared = (part.mimetype || "application/octet-stream").toLowerCase();
        if (!isAvatarMime(declared)) {
          part.file.resume();
          throw new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Avatar phải là ảnh PNG, JPEG, GIF, WebP hoặc AVIF",
          );
        }

        uploadId = createSnowflake(config.workerId);
        await ensureUploadsDir(config.avatarsDir);
        size = await writeAvatar(part.file, uploadId);
        // Trần của @fastify/multipart (`fileSize`) cắt stream trước bộ đếm byte
        // riêng — phải kiểm để không lưu ảnh bị cắt cụt.
        if (part.file.truncated) {
          await removeUpload(config.avatarsDir, uploadId);
          uploadId = null;
          throw new HttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Ảnh đại diện vượt quá ${Math.floor(config.maxAvatarBytes / (1024 * 1024))}MB`,
          );
        }
        mimeType = declared;
      }
    } catch (error) {
      if (uploadId !== null) await removeUpload(config.avatarsDir, uploadId);
      throw error;
    }

    if (uploadId === null) throw badRequest('Thiếu file ảnh (trường "file")');

    // Ảnh thật hay chỉ là file đổi tên: kiểm magic bytes.
    const header = await readUploadHeader(config.avatarsDir, uploadId, HEADER_BYTES);
    const dimensions = readImageSize(header);
    if (dimensions === null) {
      await removeUpload(config.avatarsDir, uploadId);
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Nội dung tệp không phải ảnh hợp lệ (header không nhận dạng được)",
      );
    }
    // Dùng MIME suy ra từ header, không tin MIME client khai (jpeg khai png vẫn đúng).
    const detected = detectImageMime(header);
    if (detected === null) {
      await removeUpload(config.avatarsDir, uploadId);
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Định dạng ảnh không được hỗ trợ (chỉ PNG, JPEG, GIF, WebP, AVIF)",
      );
    }
    mimeType = detected;

    const previous = await pool.query<AvatarRow>(
      "SELECT upload_id FROM user_avatars WHERE user_id = $1",
      [userId],
    );
    const oldUploadId = previous.rows[0]?.upload_id ?? null;

    await pool.query(
      `INSERT INTO user_avatars (user_id, upload_id, mime_type, size, width, height)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
         SET upload_id = EXCLUDED.upload_id,
             mime_type = EXCLUDED.mime_type,
             size = EXCLUDED.size,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             updated_at = now()`,
      [userId, uploadId, mimeType, size, dimensions.width, dimensions.height],
    );
    const updated = await pool.query<UserRow>(
      "UPDATE users SET avatar_url = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [userId, avatarUrl(userId, uploadId)],
    );
    const user = updated.rows[0];
    if (user === undefined) throw notFound("Người dùng không tồn tại");

    // Xoá file cũ SAU khi DB đã trỏ sang ảnh mới.
    if (oldUploadId !== null && oldUploadId !== uploadId) {
      await removeUpload(config.avatarsDir, oldUploadId);
    }

    await broadcastUser(user);
    // Endpoint của chính mình: người gọi đang online (giống GET /users/@me).
    return reply.send(mapUser(user, "online"));
  });

  /** Gỡ avatar — quay lại hiển thị chữ cái đầu. */
  app.delete("/users/@me/avatar", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const previous = await pool.query<AvatarRow>(
      "DELETE FROM user_avatars WHERE user_id = $1 RETURNING upload_id",
      [userId],
    );
    const oldUploadId = previous.rows[0]?.upload_id ?? null;

    const updated = await pool.query<UserRow>(
      "UPDATE users SET avatar_url = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [userId],
    );
    const user = updated.rows[0];
    if (user === undefined) throw notFound("Người dùng không tồn tại");

    if (oldUploadId !== null) await removeUpload(config.avatarsDir, oldUploadId);
    await broadcastUser(user);
    // Endpoint của chính mình: người gọi đang online (giống GET /users/@me).
    return reply.send(mapUser(user, "online"));
  });

  /**
   * Ghi ảnh avatar xuống đĩa, chặn cứng ở `maxAvatarBytes`.
   * Viết tại đây (thay vì dùng `writeUpload`) để thông báo lỗi nói rõ "ảnh".
   */
  async function writeAvatar(source: NodeJS.ReadableStream, id: string): Promise<number> {
    const target = path.join(config.avatarsDir, id);
    let written = 0;
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer | string>) {
          for await (const chunk of chunks) {
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            written += buffer.length;
            if (written > config.maxAvatarBytes) {
              throw new HttpError(
                413,
                "PAYLOAD_TOO_LARGE",
                `Ảnh đại diện vượt quá ${Math.floor(config.maxAvatarBytes / (1024 * 1024))}MB`,
              );
            }
            yield buffer;
          }
        },
        createWriteStream(target),
      );
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
    return written;
  }
}
