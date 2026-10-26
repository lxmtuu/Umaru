import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { S3FileStore } from "./s3.js";

/**
 * Lớp lưu trữ file tải lên — **một interface, hai chỗ chứa**.
 *
 * `local`: ghi xuống đĩa (mặc định, không cần dịch vụ ngoài).
 * `s3`: object storage tương thích S3/R2 (bật bằng `STORAGE_DRIVER=s3`).
 *
 * Toàn bộ đường dẫn file đi qua interface này nên route và DB không biết tệp
 * nằm ở đâu. Đổi kho là đổi một biến môi trường, không sửa route.
 *
 * Vì sao phải có `s3` chứ không chỉ đĩa: container bị thay mỗi lần deploy và
 * volume cục bộ không chia sẻ giữa các node → tệp đính kèm biến mất hoặc 404
 * tuỳ node trả lời. Xem `docs/adr` và `DEPLOY.md`.
 */

/** Trần cứng để một request không mang quá nhiều file. */
export const MAX_FILES_PER_MESSAGE = 4;

/**
 * MIME được phép tải lên.
 *
 * Cố ý **không** cho `image/svg+xml` và `text/html`: hai loại này chứa được
 * script, mà file lại phục vụ từ chính origin API → thành XSS. Ảnh raster,
 * PDF, văn bản thuần và file nén là đủ cho nhóm dev/học tập.
 */
export const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
  "application/x-7z-compressed",
  "application/gzip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_TYPES.has(mime.toLowerCase().split(";")[0]?.trim() ?? "");
}

/** Tên hiển thị: bỏ đường dẫn, ký tự điều khiển; cắt 255 ký tự. */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (cleaned.length === 0) return "file";
  return [...cleaned].slice(0, 255).join("");
}

export interface WriteOptions {
  /** Lưu kèm MIME để tải trực tiếp từ kho (khi có presigned URL) vẫn đúng kiểu. */
  contentType?: string;
  /** Thông báo riêng khi vượt trần (avatar nói "ảnh", tệp đính kèm nói "file"). */
  tooLargeMessage?: string;
}

/**
 * Một chỗ chứa file, khoá là id snowflake.
 *
 * Mọi phương thức đều **idempotent với tệp không tồn tại** ở chỗ dễ gây lỗi:
 * `size` trả `null`, `remove` không ném, `read` ném 404 (route đã kiểm `size`
 * trước nên trường hợp này là hiếm).
 */
export interface FileStore {
  write(
    id: string,
    source: NodeJS.ReadableStream,
    maxBytes: number,
    options?: WriteOptions,
  ): Promise<number>;
  read(id: string): Promise<Readable>;
  size(id: string): Promise<number | null>;
  /** Đọc `limit` byte đầu (đủ cho header ảnh). */
  peek(id: string, limit: number): Promise<Buffer>;
  remove(id: string): Promise<void>;
}

export interface Stores {
  attachments: FileStore;
  avatars: FileStore;
  driver: "local" | "s3";
}

/** Chỉ cho id dạng snowflake đi vào đường dẫn — không có `../` để mà lọt. */
export function uploadPath(dir: string, attachmentId: string): string {
  if (!/^\d{1,20}$/.test(attachmentId)) {
    throw new Error(`attachment id không hợp lệ: ${attachmentId}`);
  }
  return path.join(dir, attachmentId);
}

export class LocalFileStore implements FileStore {
  constructor(private readonly dir: string) {}

  async write(
    id: string,
    source: NodeJS.ReadableStream,
    maxBytes: number,
    options: WriteOptions = {},
  ): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const target = uploadPath(this.dir, id);
    const sink = createWriteStream(target);
    let size = 0;
    let aborted = false;

    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer | string>) {
          for await (const chunk of chunks) {
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            size += buffer.length;
            if (size > maxBytes) {
              aborted = true;
              throw new HttpError(
                413,
                "PAYLOAD_TOO_LARGE",
                options.tooLargeMessage ??
                  `File vượt quá ${Math.floor(maxBytes / (1024 * 1024))}MB`,
              );
            }
            yield buffer;
          }
        },
        sink,
      );
    } catch (error) {
      // File dở dang phải bị xoá: để lại là lần ghi sau cùng id vẫn thấy rác,
      // và `size()` sẽ trả kích thước của tệp cụt.
      await unlink(target).catch(() => undefined);
      throw error;
    }

    if (aborted) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", options.tooLargeMessage ?? "File quá lớn");
    }
    return size;
  }

  async read(id: string): Promise<Readable> {
    return createReadStream(uploadPath(this.dir, id));
  }

  async size(id: string): Promise<number | null> {
    try {
      const info = await stat(uploadPath(this.dir, id));
      return info.size;
    } catch {
      return null;
    }
  }

  async peek(id: string, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(uploadPath(this.dir, id));
    try {
      for await (const chunk of stream) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        chunks.push(buffer);
        total += buffer.length;
        if (total >= limit) break;
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(chunks).subarray(0, limit);
  }

  async remove(id: string): Promise<void> {
    await unlink(uploadPath(this.dir, id)).catch(() => undefined);
  }
}

/**
 * Dựng kho theo cấu hình. Gọi **một lần** lúc khởi động (`app.ts`) rồi truyền
 * xuống route, không dựng lại mỗi request.
 */
export function createStores(config: Config): Stores {
  if (config.storage === null) {
    return {
      attachments: new LocalFileStore(config.uploadsDir),
      avatars: new LocalFileStore(config.avatarsDir),
      driver: "local",
    };
  }
  const shared = {
    bucket: config.storage.bucket,
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  };
  const base = config.storage.prefix.replace(/^\/+|\/+$/g, "");
  const join = (suffix: string) => (base.length === 0 ? suffix : `${base}/${suffix}`);
  return {
    attachments: new S3FileStore({ ...shared, prefix: join("attachments") }),
    avatars: new S3FileStore({ ...shared, prefix: join("avatars") }),
    driver: "s3",
  };
}
