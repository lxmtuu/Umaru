import { Permission, createSnowflake, hasPermission, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadGuildContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import type { Stores } from "../uploads/storage.js";
import { HEADER_BYTES, detectImageMime, readImageSize } from "../uploads/imageSize.js";
import {
  MAX_PACKS_PER_GUILD,
  MAX_STICKER_BYTES,
  MAX_STICKERS_PER_PACK,
  STICKER_MIME_TYPES,
  checkStickerDimensions,
  mapSticker,
  mapStickerPack,
  parseStickerName,
  type StickerPackRow,
  type StickerRow,
} from "../stickers.js";

export interface StickerDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  storage: Stores;
}

const STICKER_COLUMNS =
  "s.id, s.pack_id, s.name, s.upload_id, s.mime_type, s.size, s.width, s.height, p.guild_id";

/**
 * Sticker theo server.
 *
 * Quyền: xem = thành viên server; tạo/sửa/xoá = `MANAGE_EXPRESSIONS` (hoặc
 * ADMINISTRATOR/owner, `resolvePermissions` đã trả ALL cho hai nhánh đó).
 *
 * Ảnh phục vụ qua endpoint **có xác thực** chứ không phải file tĩnh: cùng lý do
 * với avatar — nội dung của server kín không được nằm ở URL đoán được.
 */
export function registerStickerRoutes(app: FastifyInstance, deps: StickerDeps): void {
  const { pool, config, storage } = deps;
  const guard = createAuthGuard(deps.tokens);

  /** Thành viên server, trả context (đã kiểm quyền xem). */
  const requireMember = async (userId: string, guildId: string) => {
    const context = await loadGuildContext(pool, userId as Snowflake, guildId);
    if (context === null) throw notFound("Server không tồn tại");
    return context;
  };

  const requireManager = async (userId: string, guildId: string) => {
    const context = await requireMember(userId, guildId);
    if (!hasPermission(context.permissions, Permission.MANAGE_EXPRESSIONS)) {
      throw forbidden("Cần quyền quản lý sticker để làm việc này");
    }
    return context;
  };

  const loadPack = async (packId: string): Promise<StickerPackRow> => {
    const result = await pool.query<StickerPackRow>(
      "SELECT id, guild_id, name, created_by, created_at FROM sticker_packs WHERE id = $1",
      [packId],
    );
    const pack = result.rows[0];
    if (pack === undefined) throw notFound("Gói sticker không tồn tại");
    return pack;
  };

  const loadSticker = async (stickerId: string): Promise<StickerRow> => {
    const result = await pool.query<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
         FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
        WHERE s.id = $1`,
      [stickerId],
    );
    const sticker = result.rows[0];
    if (sticker === undefined) throw notFound("Sticker không tồn tại");
    return sticker;
  };

  const stickersOf = async (packIds: string[]): Promise<StickerRow[]> => {
    if (packIds.length === 0) return [];
    const result = await pool.query<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
         FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
        WHERE s.pack_id = ANY($1::bigint[])
        ORDER BY s.created_at, s.id`,
      [packIds],
    );
    return result.rows;
  };

  /** Danh sách gói + sticker của một server (bảng chọn sticker dùng cái này). */
  app.get<{ Params: { guildId: string } }>(
    "/guilds/:guildId/sticker-packs",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { guildId } = request.params;
      await requireMember(userId, guildId);

      const packs = await pool.query<StickerPackRow>(
        `SELECT id, guild_id, name, created_by, created_at
           FROM sticker_packs WHERE guild_id = $1 ORDER BY created_at, id`,
        [guildId],
      );
      const stickers = await stickersOf(packs.rows.map((pack) => pack.id));
      return reply.send(packs.rows.map((pack) => mapStickerPack(pack, stickers)));
    },
  );

  app.post<{ Params: { guildId: string } }>(
    "/guilds/:guildId/sticker-packs",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { guildId } = request.params;
      await requireManager(userId, guildId);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = parseStickerName(body.name, "Tên gói");

      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM sticker_packs WHERE guild_id = $1",
        [guildId],
      );
      if (Number(count.rows[0]?.count ?? "0") >= MAX_PACKS_PER_GUILD) {
        throw badRequest(`Mỗi server tối đa ${MAX_PACKS_PER_GUILD} gói sticker`);
      }

      const existing = await pool.query("SELECT 1 FROM sticker_packs WHERE guild_id = $1 AND name = $2", [
        guildId,
        name,
      ]);
      if (existing.rowCount !== 0) throw new HttpError(409, "NAME_TAKEN", "Server đã có gói tên này");

      const inserted = await pool.query<StickerPackRow>(
        `INSERT INTO sticker_packs (id, guild_id, name, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, guild_id, name, created_by, created_at`,
        [createSnowflake(config.workerId), guildId, name, userId],
      );
      const pack = inserted.rows[0];
      if (pack === undefined) throw new Error("Không đọc được gói vừa tạo");
      return reply.code(201).send(mapStickerPack(pack, []));
    },
  );

  app.patch<{ Params: { packId: string } }>(
    "/sticker-packs/:packId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const pack = await loadPack(request.params.packId);
      await requireManager(userId, pack.guild_id);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = parseStickerName(body.name, "Tên gói");

      const clash = await pool.query(
        "SELECT 1 FROM sticker_packs WHERE guild_id = $1 AND name = $2 AND id <> $3",
        [pack.guild_id, name, pack.id],
      );
      if (clash.rowCount !== 0) throw new HttpError(409, "NAME_TAKEN", "Server đã có gói tên này");

      const updated = await pool.query<StickerPackRow>(
        `UPDATE sticker_packs SET name = $2 WHERE id = $1
         RETURNING id, guild_id, name, created_by, created_at`,
        [pack.id, name],
      );
      const row = updated.rows[0];
      if (row === undefined) throw notFound("Gói sticker không tồn tại");
      return reply.send(mapStickerPack(row, await stickersOf([row.id])));
    },
  );

  /**
   * Xoá gói = xoá mọi sticker trong gói. File ảnh bị xoá **sau** khi DB xong;
   * lỗi giữa đường chỉ để lại file mồ côi (dọn được), không làm mất dữ liệu
   * đang dùng.
   */
  app.delete<{ Params: { packId: string } }>(
    "/sticker-packs/:packId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const pack = await loadPack(request.params.packId);
      await requireManager(userId, pack.guild_id);

      const inUse = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM messages m JOIN stickers s ON s.id = m.sticker_id
          WHERE s.pack_id = $1`,
        [pack.id],
      );
      if (Number(inUse.rows[0]?.count ?? "0") > 0) {
        throw new HttpError(
          409,
          "STICKER_IN_USE",
          "Gói này đang được dùng trong tin nhắn — xoá các sticker đang dùng trước",
        );
      }

      const uploads = await pool.query<{ upload_id: string }>(
        "SELECT upload_id FROM stickers WHERE pack_id = $1",
        [pack.id],
      );
      await pool.query("DELETE FROM sticker_packs WHERE id = $1", [pack.id]);
      for (const row of uploads.rows) {
        await storage.stickers.remove(row.upload_id);
      }
      return reply.code(204).send();
    },
  );

  /**
   * Tải sticker lên (`multipart/form-data`: `name` + một file).
   *
   * Kiểm như avatar — MIME khai báo → **magic bytes** → kích thước — cộng thêm
   * ràng buộc vuông. File được ghi **trước** khi insert để lỗi DB không để lại
   * dòng trỏ tới file không tồn tại; nếu insert hỏng thì xoá file vừa ghi.
   */
  app.post<{ Params: { packId: string } }>(
    "/sticker-packs/:packId/stickers",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const pack = await loadPack(request.params.packId);
      await requireManager(userId, pack.guild_id);

      if (!request.isMultipart()) {
        throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần gửi multipart/form-data");
      }

      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM stickers WHERE pack_id = $1",
        [pack.id],
      );
      if (Number(count.rows[0]?.count ?? "0") >= MAX_STICKERS_PER_PACK) {
        throw badRequest(`Mỗi gói tối đa ${MAX_STICKERS_PER_PACK} sticker`);
      }

      let name: string | null = null;
      let uploadId: string | null = null;
      let size = 0;
      try {
        for await (const part of request.parts()) {
          if (part.type === "field") {
            if (part.fieldname === "name") name = String(part.value);
            continue;
          }
          if (uploadId !== null) {
            part.file.resume();
            throw badRequest("Chỉ nhận một ảnh mỗi lần");
          }
          const declared = (part.mimetype || "application/octet-stream").toLowerCase();
          if (!STICKER_MIME_TYPES.has(declared)) {
            part.file.resume();
            throw new HttpError(
              415,
              "UNSUPPORTED_MEDIA_TYPE",
              "Sticker phải là ảnh PNG, APNG, GIF, WebP hoặc AVIF",
            );
          }
          uploadId = createSnowflake(config.workerId);
          size = await storage.stickers.write(uploadId, part.file, MAX_STICKER_BYTES, {
            contentType: declared,
            tooLargeMessage: `Sticker tối đa ${Math.floor(MAX_STICKER_BYTES / 1024)}KB`,
          });
          if (part.file.truncated) {
            await storage.stickers.remove(uploadId);
            uploadId = null;
            throw new HttpError(
              413,
              "PAYLOAD_TOO_LARGE",
              `Sticker tối đa ${Math.floor(MAX_STICKER_BYTES / 1024)}KB`,
            );
          }
        }
      } catch (error) {
        if (uploadId !== null) await storage.stickers.remove(uploadId);
        throw error;
      }

      if (uploadId === null) throw badRequest('Thiếu file ảnh (trường "file")');

      const header = await storage.stickers.peek(uploadId, HEADER_BYTES);
      const dimensions = readImageSize(header);
      const detected = dimensions === null ? null : detectImageMime(header);
      if (dimensions === null || detected === null || !STICKER_MIME_TYPES.has(detected)) {
        await storage.stickers.remove(uploadId);
        throw new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Nội dung tệp không phải ảnh hợp lệ (header không nhận dạng được)",
        );
      }
      try {
        checkStickerDimensions(dimensions.width, dimensions.height);
      } catch (error) {
        await storage.stickers.remove(uploadId);
        throw error;
      }

      const stickerName = parseStickerName(name ?? "", "Tên sticker");
      const clash = await pool.query("SELECT 1 FROM stickers WHERE pack_id = $1 AND name = $2", [
        pack.id,
        stickerName,
      ]);
      if (clash.rowCount !== 0) {
        await storage.stickers.remove(uploadId);
        throw new HttpError(409, "NAME_TAKEN", "Gói đã có sticker tên này");
      }

      const inserted = await pool.query<StickerRow>(
        `INSERT INTO stickers (id, pack_id, name, upload_id, mime_type, size, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, pack_id, name, upload_id, mime_type, size, width, height`,
        [
          // Id của sticker **khác** uploadId: xoá rồi tải lại cùng ảnh là một
          // sticker mới, và URL ảnh (`uploadId`) vẫn cache được vĩnh viễn.
          createSnowflake(config.workerId),
          pack.id,
          stickerName,
          uploadId,
          detected,
          size,
          dimensions.width,
          dimensions.height,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Không đọc được sticker vừa tạo");
      // `guild_id` không nằm trong RETURNING của INSERT (cột ở bảng khác).
      return reply.code(201).send(mapSticker({ ...row, guild_id: pack.guild_id }));
    },
  );

  app.delete<{ Params: { stickerId: string } }>(
    "/stickers/:stickerId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const sticker = await loadSticker(request.params.stickerId);
      await requireManager(userId, sticker.guild_id);

      const inUse = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM messages WHERE sticker_id = $1",
        [sticker.id],
      );
      if (Number(inUse.rows[0]?.count ?? "0") > 0) {
        throw new HttpError(
          409,
          "STICKER_IN_USE",
          "Sticker đang được dùng trong tin nhắn — không xoá được",
        );
      }

      await pool.query("DELETE FROM stickers WHERE id = $1", [sticker.id]);
      await storage.stickers.remove(sticker.upload_id);
      return reply.code(204).send();
    },
  );

  /** Ảnh sticker: chỉ thành viên server mới tải được. */
  app.get<{ Params: { guildId: string; stickerId: string } }>(
    "/guilds/:guildId/stickers/:stickerId/image",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { guildId, stickerId } = request.params;
      await requireMember(userId, guildId);

      const sticker = await loadSticker(stickerId);
      // Sticker của server khác thì coi như không tồn tại, không phải 403:
      // 403 xác nhận id có thật.
      if (sticker.guild_id !== guildId) throw notFound("Sticker không tồn tại");

      const size = await storage.stickers.size(sticker.upload_id);
      if (size === null) throw notFound("Sticker không tồn tại");

      return reply
        .code(200)
        .header("content-type", sticker.mime_type)
        .header("content-length", String(size))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        // URL chứa uploadId → nội dung của một sticker là bất biến.
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("etag", `"${sticker.upload_id}"`)
        .send(await storage.stickers.read(sticker.upload_id));
    },
  );
}
