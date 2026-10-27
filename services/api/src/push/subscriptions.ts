import type { Pool } from "../db.js";
import { badRequest } from "../http.js";

/**
 * Web Push: phần dữ liệu (subscription) — không dính gì tới mạng.
 *
 * Tách khỏi `sender.ts` để **kiểm tra dữ liệu vào** là hàm thuần, test được mà
 * không cần dựng dịch vụ push giả: body do trình duyệt gửi lên, tức là dữ liệu
 * không tin được, và một subscription rác sẽ làm mọi lần gửi sau đó ném lỗi
 * (web-push mã hoá bằng đúng khoá này).
 */

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Trần ký tự cho endpoint/keys — endpoint thật thường < 300 ký tự. */
const MAX_ENDPOINT_LENGTH = 1000;
const MAX_KEY_LENGTH = 200;

/** Số subscription tối đa cho một người (điện thoại + laptop + vài profile). */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Base64url → bytes. Trả `null` thay vì ném: dùng cho kiểm tra dữ liệu vào.
 * Chấp nhận cả base64 thường (một số trình duyệt cũ) bằng cách đổi `-_` → `+/`.
 */
export function decodeBase64Url(raw: string): Buffer | null {
  if (raw.length === 0) return null;
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  try {
    return Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
}

/**
 * Kiểm tra một subscription do client gửi lên.
 *
 * Kiểm **độ dài khoá**, không chỉ định dạng: `p256dh` là một điểm P-256 không
 * nén (65 byte, byte đầu `0x04`), `auth` là 16 byte. Khoá sai kích thước vẫn là
 * base64 hợp lệ nhưng sẽ làm bước mã hoá AES-GCM hỏng **trong lúc gửi thông
 * báo**, tức là lỗi xuất hiện ở chỗ không ai ngờ — chặn ngay lúc đăng ký thì
 * lỗi nằm đúng chỗ người dùng đang nhìn.
 */
export function parsePushSubscription(body: unknown): PushSubscriptionInput {
  if (typeof body !== "object" || body === null) throw badRequest("Body phải là JSON");
  const record = body as Record<string, unknown>;
  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw badRequest('Thiếu trường "endpoint"');
  }
  if (endpoint.length > MAX_ENDPOINT_LENGTH) throw badRequest('"endpoint" quá dài');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('"endpoint" phải là URL');
  }
  // Push endpoint luôn là https: nhận http nghĩa là ai đó đang thử chèn một địa
  // chỉ nội bộ để server tự gửi request (SSRF) thay vì nhận thông báo.
  if (url.protocol !== "https:") throw badRequest('"endpoint" phải là https');

  const keys = record.keys;
  if (typeof keys !== "object" || keys === null) throw badRequest('Thiếu trường "keys"');
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length === 0 || p256dh.length > MAX_KEY_LENGTH) {
    throw badRequest('"keys.p256dh" không hợp lệ');
  }
  if (typeof auth !== "string" || auth.length === 0 || auth.length > MAX_KEY_LENGTH) {
    throw badRequest('"keys.auth" không hợp lệ');
  }
  const point = decodeBase64Url(p256dh);
  if (point === null || point.length !== 65 || point[0] !== 0x04) {
    throw badRequest('"keys.p256dh" phải là điểm P-256 không nén (65 byte)');
  }
  const secret = decodeBase64Url(auth);
  if (secret === null || secret.length !== 16) {
    throw badRequest('"keys.auth" phải là 16 byte');
  }
  return { endpoint, p256dh, auth };
}

/** Endpoint từ body DELETE — chỉ cần đúng URL https, không cần khoá. */
export function parsePushEndpoint(body: unknown): string {
  if (typeof body !== "object" || body === null) throw badRequest("Body phải là JSON");
  const endpoint = (body as Record<string, unknown>).endpoint;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw badRequest('Thiếu trường "endpoint"');
  }
  if (endpoint.length > MAX_ENDPOINT_LENGTH) throw badRequest('"endpoint" quá dài');
  return endpoint;
}

export async function listSubscriptions(
  pool: Pool,
  userId: string,
): Promise<PushSubscriptionInput[]> {
  const result = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return result.rows;
}

/**
 * Đăng ký một subscription. `ON CONFLICT (endpoint)` **ghi đè `user_id`**: đăng
 * nhập tài khoản khác trên cùng trình duyệt phải chuyển hướng thông báo sang
 * người mới, và xoá luôn lịch sử lỗi (khoá mới, endpoint mới).
 */
export async function upsertSubscription(
  pool: Pool,
  userId: string,
  subscription: PushSubscriptionInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           created_at = now(),
           failure_count = 0`,
    [subscription.endpoint, userId, subscription.p256dh, subscription.auth],
  );
  // Giữ trần: xoá những subscription cũ nhất vượt hạn (đăng ký lặp ở nhiều
  // profile sẽ không tích vô hạn).
  await pool.query(
    `DELETE FROM push_subscriptions
      WHERE user_id = $1
        AND endpoint NOT IN (
          SELECT endpoint FROM push_subscriptions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2
        )`,
    [userId, MAX_SUBSCRIPTIONS_PER_USER],
  );
}

/** Xoá subscription của **chính** người dùng; trả về số dòng đã xoá. */
export async function deleteSubscription(
  pool: Pool,
  userId: string,
  endpoint: string,
): Promise<number> {
  const result = await pool.query(
    "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
    [userId, endpoint],
  );
  return result.rowCount ?? 0;
}

/** Dọn endpoint đã chết (404/410) — không cần biết của ai. */
export async function deleteEndpoint(pool: Pool, endpoint: string): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

/** Ghi nhận lần gửi thành công (dùng để biết subscription còn sống). */
export async function noteDeliverySuccess(pool: Pool, endpoint: string): Promise<void> {
  await pool.query(
    `UPDATE push_subscriptions
        SET last_success_at = now(), failure_count = 0
      WHERE endpoint = $1`,
    [endpoint],
  );
}

/**
 * Ghi nhận lần gửi lỗi. Sau `MAX_FAILURES` lần liên tiếp thì **xoá** dòng: một
 * subscription hỏng mà giữ lại chỉ làm mỗi tin nhắn sau đó chậm thêm một lần
 * chờ timeout.
 */
export const MAX_FAILURES = 5;

export async function noteDeliveryFailure(pool: Pool, endpoint: string): Promise<void> {
  await pool.query(
    `UPDATE push_subscriptions
        SET failure_count = failure_count + 1
      WHERE endpoint = $1`,
    [endpoint],
  );
  await pool.query(
    "DELETE FROM push_subscriptions WHERE endpoint = $1 AND failure_count >= $2",
    [endpoint, MAX_FAILURES],
  );
}
