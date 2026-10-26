import { createHash, createHmac } from "node:crypto";

/**
 * Ký request theo AWS Signature Version 4 (header-based).
 *
 * Vì sao tự viết thay vì thêm `@aws-sdk/client-s3`: chỉ cần đúng **một** thuật
 * toán ~100 dòng và bốn thao tác HTTP (PUT/GET/HEAD/DELETE). Thêm SDK nghĩa là
 * thêm ~10 MB dependency vào image, mà phần lớn là thứ mình không dùng.
 *
 * Đổi lại phải chứng minh nó đúng: `sigv4.test.ts` kiểm bằng **bộ vector mẫu
 * chính thức trong tài liệu AWS** (GET object, PUT object, GET ?lifecycle,
 * GET ?max-keys&prefix) — cùng các giá trị `Authorization` mà tài liệu ghi. Có
 * vector cho cả query string và cả `%24` trong đường dẫn.
 *
 * Hai điểm người ta hay làm sai và ở đây làm đúng:
 *   1. **Không double-encode đường dẫn.** S3 canonical URI là đường dẫn đã được
 *      encode **một** lần. `decodeURIComponent` rồi `encodeURIComponent` từng
 *      đoạn (như dưới) cho ra đúng một lần encode bất kể đầu vào đã encode chưa.
 *      Encode thẳng chuỗi đã encode sẽ biến `test$file.text` thành
 *      `test%2524file.text` → chữ ký sai, S3 trả 403 SignatureDoesNotMatch.
 *   2. **Query string phải sort.** Không sort thì chữ ký đúng với thứ tự client
 *      gửi, còn S3 sort lại → lệch.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Mặc định `s3`. */
  service?: string;
}

/** SHA-256 của chuỗi rỗng — payload hash cho request không có body. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Giá trị `x-amz-content-sha256` khi không muốn băm body (bắt buộc qua HTTPS). */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * Encode theo RFC 3986 đúng như AWS yêu cầu: giữ `A-Za-z0-9-_.~`, encode phần
 * còn lại. `encodeURIComponent` giữ nguyên `!'()*` — bốn ký tự này AWS **cũng**
 * muốn encode, nên phải thay tay.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20130524T000000Z` */
export function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Canonical URI: encode **một** lần từng đoạn đường dẫn.
 *
 * `decodeURIComponent` có thể ném lỗi với `%` rác; khi đó dùng nguyên đoạn —
 * thà ký sai và nhận 403 (thấy ngay) còn hơn ném 500 không rõ nguyên nhân.
 */
export function canonicalUri(pathname: string): string {
  const path = pathname.length === 0 ? "/" : pathname;
  return path
    .split("/")
    .map((segment) => {
      if (segment.length === 0) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return uriEncode(segment);
      }
      return uriEncode(decoded);
    })
    .join("/");
}

/** Canonical query string: encode, sort theo key rồi theo value, nối `k=v&…`. */
export function canonicalQuery(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([uriEncode(key), uriEncode(value)]);
  }
  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1,
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function signingKey(
  credentials: AwsCredentials,
  dateStamp: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

export interface SignOptions {
  method: string;
  url: URL;
  /** Header phụ cần ký (range, content-type…). `host` tự thêm. */
  headers?: Record<string, string>;
  /** Hex SHA-256 của body, hoặc `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  credentials: AwsCredentials;
  /** Đồng hồ — test bơm mốc thời gian cố định để so với vector của AWS. */
  now?: Date;
}

/**
 * Trả về **toàn bộ** header cần gửi: header của người gọi + `host`,
 * `x-amz-content-sha256`, `x-amz-date`, `authorization`.
 *
 * Giá trị header được trim và gộp khoảng trắng khi ký (đúng spec), nhưng trả về
 * bản đã chuẩn hoá để cái gửi đi khớp cái đã ký — lệch một dấu cách là 403.
 */
export function signRequest(options: SignOptions): Record<string, string> {
  const { method, url, payloadHash, credentials } = options;
  const service = credentials.service ?? "s3";
  const amzDate = formatAmzDate(options.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);

  const toSign: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    toSign[key.toLowerCase()] = value;
  }
  toSign["host"] = url.host;
  toSign["x-amz-content-sha256"] = payloadHash;
  toSign["x-amz-date"] = amzDate;

  const entries = Object.entries(toSign)
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = entries.map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaders = entries.map(([key]) => key).join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    signingKey(credentials, dateStamp, service),
    stringToSign,
  );

  const headers: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key === "host") continue; // Node tự đặt, và nó phải khớp URL.
    headers[key] = value;
  }
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
