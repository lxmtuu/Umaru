import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress } from "./extract.js";

/**
 * Tải một trang HTML để dựng embed.
 *
 * Nội dung tin nhắn do người dùng nhập ⇒ URL là **dữ liệu không tin được**.
 * Hàm này là chỗ duy nhất gọi ra ngoài, nên mọi hàng rào nằm ở đây:
 *
 *   * chỉ `http`/`https`;
 *   * phân giải DNS **trước**, chặn địa chỉ nội bộ/loopback/metadata, rồi nối
 *     tới đúng IP vừa kiểm (`lookup` riêng) — chặn DNS rebinding (tên miền trả
 *     IP công khai lúc kiểm, IP nội bộ lúc nối);
 *   * theo redirect thủ công, kiểm lại **từng chặng**;
 *   * chỉ nhận `text/html`, trần dung lượng và timeout.
 */

export interface FetchHtmlOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Chỉ dùng cho dev/test: cho phép gọi 127.0.0.1 (server test). */
  allowPrivateHosts: boolean;
  /** Trần số redirect. */
  maxRedirects?: number;
}

export interface FetchedPage {
  html: string;
  /** URL sau khi theo redirect — ảnh tương đối phải ghép với URL này. */
  finalUrl: string;
}

export class EmbedFetchError extends Error {}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export async function fetchHtml(rawUrl: string, options: FetchHtmlOptions): Promise<FetchedPage> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = parseHttpUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await requestOnce(current, options);
    if (REDIRECT_CODES.has(response.status) && response.location !== null) {
      current = parseHttpUrl(new URL(response.location, current).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new EmbedFetchError(`HTTP ${response.status}`);
    }
    if (!response.contentType.includes("html")) {
      // Ảnh/PDF/video không có thẻ meta — bỏ luôn, khỏi đọc thân.
      throw new EmbedFetchError(`content-type không phải HTML: ${response.contentType || "(trống)"}`);
    }
    return { html: response.body, finalUrl: current.toString() };
  }
  throw new EmbedFetchError("quá nhiều redirect");
}

function parseHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbedFetchError(`giao thức không hỗ trợ: ${url.protocol}`);
  }
  if (url.hostname === "") throw new EmbedFetchError("URL không có host");
  return url;
}

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
  location: string | null;
}

/**
 * Địa chỉ được phép nối tới. Trả về `undefined` khi `allowPrivateHosts` (dev) —
 * khi đó dùng resolver mặc định của Node.
 */
async function vettedAddresses(
  hostname: string,
  options: FetchHtmlOptions,
): Promise<string[] | undefined> {
  if (options.allowPrivateHosts) return undefined;
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new EmbedFetchError("không phân giải được tên miền");
  const allowed = records.filter((record) => !isBlockedAddress(record.address));
  if (allowed.length === 0) {
    throw new EmbedFetchError(`chặn địa chỉ nội bộ: ${records.map((r) => r.address).join(", ")}`);
  }
  return allowed.map((record) => record.address);
}

async function requestOnce(url: URL, options: FetchHtmlOptions): Promise<RawResponse> {
  const addresses = await vettedAddresses(url.hostname, options);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = transport(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        headers: {
          // Nhiều trang chặn UA lạ hoặc trả bản rút gọn; xưng danh đúng để chủ
          // trang biết ai đang gọi.
          "user-agent": "UmaruBot/1.0 (+https://umaru.app/bot; embed preview)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "vi,en;q=0.8",
        },
        // Nối tới đúng IP đã kiểm — `all` để Node tự thử lần lượt nếu IP đầu lỗi.
        ...(addresses === undefined
          ? {}
          : {
              lookup: (
                _hostname: string,
                lookupOptions: { all?: boolean },
                callback: (
                  error: NodeJS.ErrnoException | null,
                  address: string | { address: string; family: number }[],
                  family?: number,
                ) => void,
              ) => {
                if (lookupOptions.all === true) {
                  callback(
                    null,
                    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
                  );
                  return;
                }
                const first = addresses[0] as string;
                callback(null, first, first.includes(":") ? 6 : 4);
              },
            }),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        // Redirect/không phải 2xx: không cần thân, đọc xong là bỏ ngay.
        if (REDIRECT_CODES.has(status)) {
          settled = true;
          response.resume();
          resolve({ status, body: "", contentType: "", location });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            response.destroy(new EmbedFetchError(`trang lớn hơn ${options.maxBytes} byte`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          settled = true;
          resolve({
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(response.headers["content-type"] ?? "").toLowerCase(),
            location,
          });
        });
        response.on("error", fail);
      },
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new EmbedFetchError(`quá ${options.timeoutMs}ms`));
    });
    request.on("error", (error) => fail(error));
    request.end();
  });
}
