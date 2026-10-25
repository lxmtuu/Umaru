import type { Snowflake } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { notFound } from "../http.js";
import { readUpload, uploadSize } from "./storage.js";

export interface UploadDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
}

interface AttachmentLookupRow {
  id: string;
  channel_id: string;
  filename: string;
  mime_type: string;
  size: string | number;
}

/**
 * `GET /api/v1/attachments/:attachmentId` — phục vụ file đã tải lên.
 *
 * Kiểm quyền y như đọc tin nhắn (VIEW_CHANNEL của kênh chứa tin) chứ không chỉ
 * kiểm "đã đăng nhập": file trong kênh riêng tư không được lộ cho người ngoài.
 * Client tải bằng fetch kèm Bearer token rồi dựng blob URL — không đặt token
 * vào query string (tránh lọt vào log/referrer).
 */
export function registerUploadRoutes(app: FastifyInstance, deps: UploadDeps): void {
  const { pool, config } = deps;
  const guard = createAuthGuard(deps.tokens);

  app.get<{ Params: { attachmentId: string } }>(
    "/attachments/:attachmentId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { attachmentId } = request.params;

      const result = await pool.query<AttachmentLookupRow>(
        `SELECT a.id, a.filename, a.mime_type, a.size, m.channel_id
           FROM attachments a
           JOIN messages m ON m.id = a.message_id
          WHERE a.id = $1`,
        [attachmentId],
      );
      const row = result.rows[0];
      // Không tồn tại / không có quyền xem kênh → cùng một 404.
      if (row === undefined) throw notFound("Tệp không tồn tại");
      await loadChannelContext(pool, userId as Snowflake, row.channel_id);

      const size = await uploadSize(config.uploadsDir, attachmentId);
      if (size === null) throw notFound("Tệp không tồn tại");

      // Tên file đã được lọc ký tự điều khiển lúc lưu; vẫn thêm dạng RFC 5987
      // để tên tiếng Việt/emoji hiện đúng khi tải về.
      const encoded = encodeURIComponent(row.filename);
      return reply
        .code(200)
        .header("content-type", row.mime_type)
        .header("content-length", String(size))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("content-disposition", `inline; filename*=UTF-8''${encoded}`)
        .send(readUpload(config.uploadsDir, attachmentId));
    },
  );
}
