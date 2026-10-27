/**
 * Đọc kết quả redirect của OAuth2 trên URL.
 *
 * Server **không** bao giờ đưa token vào URL: callback chỉ trả `?oauth_code=`
 * (mã dùng một lần, sống 120 giây) hoặc `?oauth_error=<lý do>`. SPA đổi mã lấy
 * token bằng `POST /auth/oauth/exchange`, và đúng lúc đó 2FA mới được kiểm.
 *
 * Mã phải rời khỏi thanh địa chỉ ngay sau khi đọc — cùng lý do với `verifyToken`
 * (history, ảnh chụp màn hình, người dùng copy link).
 */

/** Lý do lỗi server gắn vào `oauth_error` (đã hạ chữ thường). */
export type OAuthQueryError =
  | "access_denied"
  | "state"
  | "code"
  | "provider"
  | "account"
  | "oauth_email_taken";

export interface OAuthQueryResult {
  code: string | null;
  error: string | null;
}

/** Độ dài mã hợp lệ (server sinh 32 byte base64url, chặn 16–200). */
const MIN_CODE_LENGTH = 16;
const MAX_CODE_LENGTH = 200;
/** Chỉ nhận lý do lỗi ngắn, chữ thường — không render bất cứ thứ gì từ URL. */
const MAX_ERROR_LENGTH = 40;

/** `code` và `error` loại trừ nhau; không có tham số nào thì trả `null`. */
export function readOAuthResult(search: string): OAuthQueryResult | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const rawCode = params.get("oauth_code");
  if (rawCode !== null && rawCode.length >= MIN_CODE_LENGTH && rawCode.length <= MAX_CODE_LENGTH) {
    return { code: rawCode, error: null };
  }
  const rawError = params.get("oauth_error");
  if (rawError !== null && rawError.length > 0 && rawError.length <= MAX_ERROR_LENGTH) {
    return { code: null, error: rawError.toLowerCase() };
  }
  return null;
}

/** URL đã bỏ `oauth_code`/`oauth_error`, giữ nguyên tham số khác (kể cả hash). */
export function withoutOAuthParams(href: string): string {
  const url = new URL(href, "http://placeholder.local");
  url.searchParams.delete("oauth_code");
  url.searchParams.delete("oauth_error");
  const search = url.searchParams.toString();
  return `${url.pathname}${search.length > 0 ? `?${search}` : ""}${url.hash}`;
}
