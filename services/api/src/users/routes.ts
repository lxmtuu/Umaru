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
import { parseProfilePatch, profileUpdateFields, toPublicProfile } from "../profiles.js";
import { HEADER_BYTES, detectImageMime, readImageSize } from "../uploads/imageSize.js";
import type { Stores } from "../uploads/storage.js";

export interface UserDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
  storage: Stores;
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
  const { pool, config, publisher, storage } = deps;
  const guard = createAuthGuard(deps.tokens);

  /**
   * Phát `USER_UPDATE` tới mọi server mà người này là thành viên, và tới các
   * session của chính họ (nhiều tab/thiết bị).
   */
  const broadcastUser = async (row: UserRow): Promise<void> => {
    // Chỉ gửi phần hồ sơ: presence là trạng thái ephemeral, không được bịa
    // "online" ở đây (client sẽ tự bỏ qua nếu trường không có).
    const user: UserProfile = profileUpdateFields(row);
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

      const size = await storage.avatars.size(uploadId);
      if (size === null) throw notFound("Ảnh không tồn tại");

      return reply
        .code(200)
        .header("content-type", row.mime_type)
        .header("content-length", String(size))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("etag", `"${uploadId}"`)
        .send(await storage.avatars.read(uploadId));
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
        size = await storage.avatars.write(uploadId, part.file, config.maxAvatarBytes, {
          contentType: declared,
          tooLargeMessage: `Ảnh đại diện vượt quá ${Math.floor(
            config.maxAvatarBytes / (1024 * 1024),
          )}MB`,
        });
        // Trần của @fastify/multipart (`fileSize`) cắt stream trước bộ đếm byte
        // riêng — phải kiểm để không lưu ảnh bị cắt cụt.
        if (part.file.truncated) {
          await storage.avatars.remove(uploadId);
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
      if (uploadId !== null) await storage.avatars.remove(uploadId);
      throw error;
    }

    if (uploadId === null) throw badRequest('Thiếu file ảnh (trường "file")');

    // Ảnh thật hay chỉ là file đổi tên: kiểm magic bytes.
    const header = await storage.avatars.peek(uploadId, HEADER_BYTES);
    const dimensions = readImageSize(header);
    if (dimensions === null) {
      await storage.avatars.remove(uploadId);
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Nội dung tệp không phải ảnh hợp lệ (header không nhận dạng được)",
      );
    }
    // Dùng MIME suy ra từ header, không tin MIME client khai (jpeg khai png vẫn đúng).
    const detected = detectImageMime(header);
    if (detected === null) {
      await storage.avatars.remove(uploadId);
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
      await storage.avatars.remove(oldUploadId);
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

    if (oldUploadId !== null) await storage.avatars.remove(oldUploadId);
    await broadcastUser(user);
    // Endpoint của chính mình: người gọi đang online (giống GET /users/@me).
    return reply.send(mapUser(user, "online"));
  });

  /**
   * Sửa hồ sơ công khai (giới thiệu / đại từ / màu banner). Bỏ trường nào thì
   * trường đó giữ nguyên; gửi `null` (hoặc chuỗi rỗng) để xoá.
   *
   * Trả về chính `User` của mình và phát `USER_UPDATE` — người khác đang mở thẻ
   * hồ sơ thấy chữ đổi ngay, không phải tải lại trang.
   */
  app.patch("/users/@me/profile", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const patch = parseProfilePatch(request.body);

    // Dựng câu UPDATE theo đúng trường có mặt: gửi một trường không được phép
    // ghi đè trường khác thành NULL (PATCH nghĩa là "chỉ đổi cái này").
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.bio !== undefined) {
      values.push(patch.bio);
      sets.push(`bio = $${values.length + 1}`);
    }
    if (patch.pronouns !== undefined) {
      values.push(patch.pronouns);
      sets.push(`pronouns = $${values.length + 1}`);
    }
    if (patch.bannerColor !== undefined) {
      values.push(patch.bannerColor);
      sets.push(`banner_color = $${values.length + 1}`);
    }

    if (sets.length === 0) {
      // Không có gì để đổi: trả hồ sơ hiện tại thay vì 400 — client gửi form
      // rỗng (bấm Lưu khi không sửa gì) không đáng bị coi là lỗi.
      const current = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
      const row = current.rows[0];
      if (row === undefined) throw notFound("Người dùng không tồn tại");
      return reply.send(mapUser(row, "online"));
    }

    const updated = await pool.query<UserRow>(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      [userId, ...values],
    );
    const user = updated.rows[0];
    if (user === undefined) throw notFound("Người dùng không tồn tại");

    await broadcastUser(user);
    return reply.send(mapUser(user, "online"));
  });

  /**
   * Hồ sơ một người khác.
   *
   * Chỉ trả khi hai người **có liên hệ**: chung server, đã là bạn, hoặc đang
   * chung một DM/nhóm. Hồ sơ là thông tin tự nguyện chia sẻ, không phải danh bạ
   * tra cứu toàn hệ thống — ai biết id cũng đọc được là rò rỉ.
   *
   * Trả 404 (không phải 403) khi không có liên hệ: 403 xác nhận "id này có
   * thật", đủ để dò tài khoản.
   */
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/profile",
    { preHandler: guard },
    async (request, reply) => {
      const viewerId = requireUserId(request);
      const targetId = request.params.userId;

      if (targetId === viewerId) {
        const self = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [viewerId]);
        const row = self.rows[0];
        if (row === undefined) throw notFound("Người dùng không tồn tại");
        return reply.send(toPublicProfile(row));
      }

      const related = await pool.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM guild_members a
             JOIN guild_members b ON b.guild_id = a.guild_id
            WHERE a.user_id = $1 AND b.user_id = $2
           UNION ALL
           SELECT 1 FROM relationships r
            WHERE r.user_id = $1 AND r.target_id = $2 AND r.type = 'friend'
           UNION ALL
           SELECT 1 FROM channel_members a
             JOIN channel_members b ON b.channel_id = a.channel_id
            WHERE a.user_id = $1 AND b.user_id = $2
         ) AS ok`,
        [viewerId, targetId],
      );
      if (related.rows[0]?.ok !== true) throw notFound("Không tìm thấy người dùng");

      const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [targetId]);
      const row = result.rows[0];
      if (row === undefined) throw notFound("Không tìm thấy người dùng");
      return reply.send(toPublicProfile(row));
    },
  );
}
