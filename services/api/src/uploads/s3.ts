import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { HttpError, notFound } from "../http.js";
import { EMPTY_SHA256, sha256Hex, signRequest, type AwsCredentials } from "./sigv4.js";
import type { FileStore, WriteOptions } from "./storage.js";

/**
 * Kho file trên object storage tương thích S3 (Cloudflare R2, AWS S3, MinIO,
 * Backblaze B2…).
 *
 * Vì sao cần: bản lưu trên đĩa cục bộ chỉ đúng khi **một** container sống mãi.
 * Thực tế thì container bị thay mỗi lần deploy, và volume cục bộ không chia sẻ
 * được giữa các node — tệp đính kèm và avatar biến mất hoặc 404 tuỳ node nào
 * trả lời. Object storage gỡ cả hai.
 *
 * Quyết định đã chốt:
 *   - **Path-style URL** (`…/<bucket>/<key>`), không virtual-host: R2, MinIO và
 *     S3 đều nhận, còn virtual-host cần DNS/`<bucket>.endpoint` đúng.
 *   - **Không ký `content-length`** (chỉ gửi kèm, không nằm trong SignedHeaders):
 *     giảm một nguồn lệch chữ ký mà không mất gì.
 *   - **PUT buffer trong RAM, có trần**: tệp tối đa 10 MB nên buffer chấp nhận
 *     được, và nhờ vậy tính được payload hash để ký (stream thì phải
 *     `UNSIGNED-PAYLOAD`, kém an toàn hơn). Tải lên nhiều tệp song song tốn
 *     ~10 MB mỗi tệp — nếu sau này nâng trần lên hàng trăm MB thì phải chuyển
 *     sang multipart upload, đừng chỉ tăng `MAX_UPLOAD_BYTES`.
 *   - **GET/HEAD/DELETE không buffer**: ảnh và tệp lớn được stream thẳng ra
 *     response, không nạp cả file vào RAM.
 */

export interface S3StoreOptions {
  bucket: string;
  /** Gốc endpoint, vd `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Tiền tố khoá, vd `umaru/attachments`. Rỗng = khoá ở gốc bucket. */
  prefix: string;
  /** Đồng hồ — test bơm giờ cố định. */
  now?: () => Date;
  timeoutMs?: number;
}

interface S3Response {
  status: number;
  headers: IncomingHttpHeaders;
  stream: Readable;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class S3FileStore implements FileStore {
  private readonly credentials: AwsCredentials;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: S3StoreOptions) {
    this.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      service: "s3",
    };
    this.baseUrl = options.endpoint.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Chỉ dùng cho test/log: khoá mà tệp `id` được lưu dưới đó. */
  keyFor(id: string): string {
    assertValidId(id);
    const prefix = this.options.prefix.replace(/^\/+|\/+$/g, "");
    return prefix.length === 0 ? id : `${prefix}/${id}`;
  }

  async write(
    id: string,
    source: NodeJS.ReadableStream,
    maxBytes: number,
    options: WriteOptions = {},
  ): Promise<number> {
    const body = await readAll(source, maxBytes, options.tooLargeMessage);
    await this.send("PUT", id, {
      body,
      contentType: options.contentType,
      expected: "write",
    });
    return body.length;
  }

  async read(id: string): Promise<Readable> {
    const response = await this.send("GET", id, { expected: "read" });
    return response.stream;
  }

  async size(id: string): Promise<number | null> {
    const response = await this.send("HEAD", id, { expected: "head" });
    // HEAD không có body: phải `resume()` để socket được trả lại pool.
    response.stream.resume();
    if (response.status === 404) return null;
    this.assertOk(response, "head");
    const length = Number(response.headers["content-length"] ?? NaN);
    return Number.isFinite(length) ? length : null;
  }

  async peek(id: string, limit: number): Promise<Buffer> {
    const response = await this.send("GET", id, {
      range: `bytes=0-${Math.max(0, limit - 1)}`,
      expected: "read",
    });
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of response.stream) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        chunks.push(buffer);
        total += buffer.length;
        if (total >= limit) break;
      }
    } finally {
      response.stream.destroy();
    }
    return Buffer.concat(chunks).subarray(0, limit);
  }

  async remove(id: string): Promise<void> {
    // Xoá mà lỗi thì bỏ qua: cùng hành vi với `unlink().catch()` bản đĩa cục
    // bộ. Ném lỗi ở đây sẽ làm hỏng luồng xoá tin nhắn chỉ vì kho không có tệp.
    try {
      const response = await this.send("DELETE", id, { expected: "delete" });
      response.stream.resume();
    } catch {
      // ignore
    }
  }

  private objectUrl(id: string): URL {
    const key = this.keyFor(id);
    const encoded = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return new URL(`${this.baseUrl}/${encodeURIComponent(this.options.bucket)}/${encoded}`);
  }

  private async send(
    method: string,
    id: string,
    options: {
      body?: Buffer;
      contentType?: string;
      range?: string;
      expected: "read" | "write" | "head" | "delete";
    },
  ): Promise<S3Response> {
    const url = this.objectUrl(id);
    const unsigned: Record<string, string> = {};
    if (options.range !== undefined) unsigned["range"] = options.range;
    if (options.contentType !== undefined) unsigned["content-type"] = options.contentType;

    const payloadHash = options.body === undefined ? EMPTY_SHA256 : sha256Hex(options.body);
    const signed = signRequest({
      method,
      url,
      headers: unsigned,
      payloadHash,
      credentials: this.credentials,
      ...(this.options.now === undefined ? {} : { now: this.options.now() }),
    });

    const headers: Record<string, string> = { ...signed, ...unsigned };
    if (options.body !== undefined) headers["content-length"] = String(options.body.length);

    const response = await this.rawRequest(url, method, headers, options.body);
    if (response.status === 404) return response;
    this.assertOk(response, options.expected);
    return response;
  }

  private assertOk(response: S3Response, action: string): void {
    if (response.status >= 200 && response.status < 300) return;
    response.stream.resume();
    if (response.status === 404 && action === "read") throw notFound("Tệp không tồn tại");
    throw new HttpError(
      502,
      "STORAGE_ERROR",
      `Object storage trả ${response.status} khi ${action} tệp`,
    );
  }

  private rawRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<S3Response> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        url,
        { method, headers, timeout: this.timeoutMs },
        (response) => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            stream: response,
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error(`Object storage không trả lời sau ${this.timeoutMs}ms`));
      });
      request.on("error", (error) => reject(error));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

function assertValidId(id: string): void {
  // Cùng quy tắc với bản đĩa cục bộ: id là snowflake, nên không có đường nào
  // để tên tệp chạm ra ngoài tiền tố. Ký tự lạ ở đây là lỗi lập trình.
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error(`attachment id không hợp lệ: ${id}`);
  }
}

/** Gom stream thành Buffer nhưng dừng ngay khi vượt trần (giống bản đĩa cục bộ). */
async function readAll(
  source: NodeJS.ReadableStream,
  maxBytes: number,
  tooLargeMessage?: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) {
      // Đọc hết phần còn lại một cách bỏ đi để không kẹt kết nối multipart.
      source.resume?.();
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        tooLargeMessage ?? `File vượt quá ${Math.floor(maxBytes / (1024 * 1024))}MB`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
