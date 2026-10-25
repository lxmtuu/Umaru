import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../http.js";

/**
 * Lớp lưu trữ file tải lên.
 *
 * G1 lưu trên đĩa cục bộ (ngân sách 0đ, chưa cần R2/S3). Toàn bộ đường dẫn file
 * đi qua module này nên khi đổi sang object storage chỉ cần thay phần thân —
 * route và DB không biết file nằm ở đâu.
 *
 * Tên file trên đĩa = id snowflake (không dùng tên gốc) → không có đường nào
 * để `../` hay tên lạ chạm ra ngoài thư mục uploads.
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

export function uploadPath(dir: string, attachmentId: string): string {
  if (!/^\d{1,20}$/.test(attachmentId)) {
    throw new Error(`attachment id không hợp lệ: ${attachmentId}`);
  }
  return path.join(dir, attachmentId);
}

export async function ensureUploadsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Ghi stream vào đĩa, đếm byte và dừng ngay khi vượt trần.
 * Trả về số byte thật đã ghi (dùng làm `size` trong DB).
 */
export async function writeUpload(
  dir: string,
  attachmentId: string,
  source: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<number> {
  await ensureUploadsDir(dir);
  const target = uploadPath(dir, attachmentId);
  const sink = createWriteStream(target);
  let size = 0;
  let aborted = false;

  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer | string>) {
      for await (const chunk of chunks) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > maxBytes) {
          aborted = true;
          await unlink(target).catch(() => undefined);
          throw new HttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `File vượt quá ${Math.floor(maxBytes / (1024 * 1024))}MB`,
          );
        }
        yield buffer;
      }
    },
    sink,
  );

  if (aborted) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "File quá lớn");
  }
  return size;
}

export function readUpload(dir: string, attachmentId: string) {
  return createReadStream(uploadPath(dir, attachmentId));
}

export async function uploadSize(dir: string, attachmentId: string): Promise<number | null> {
  try {
    const info = await stat(uploadPath(dir, attachmentId));
    return info.size;
  } catch {
    return null;
  }
}

/** Đọc `limit` byte đầu file (đủ cho header ảnh). */
export async function readUploadHeader(
  dir: string,
  attachmentId: string,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = readUpload(dir, attachmentId);
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    total += buffer.length;
    if (total >= limit) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, limit);
}

export async function removeUpload(dir: string, attachmentId: string): Promise<void> {
  await unlink(uploadPath(dir, attachmentId)).catch(() => undefined);
}
