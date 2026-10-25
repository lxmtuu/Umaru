/**
 * Đọc/loại bỏ `verifyToken` trên URL.
 *
 * Link xác thực email trỏ về `/?verifyToken=...`. Token phải được xoá khỏi
 * thanh địa chỉ và history ngay sau khi dùng — nếu không, người dùng copy link
 * trang (hoặc log truy cập, ảnh chụp màn hình) sẽ làm lộ token dùng một lần.
 */

/** Độ dài token hợp lệ phía client (server chặn 16–200). */
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 200;

/** Lấy token từ query string (`?a=1&verifyToken=xyz`) — không có thì `null`. */
export function readVerificationToken(search: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const token = params.get("verifyToken");
  if (token === null) return null;
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

/** URL đã bỏ `verifyToken`, giữ nguyên các tham số khác (kể cả hash). */
export function withoutVerificationToken(href: string): string {
  const url = new URL(href, "http://placeholder.local");
  url.searchParams.delete("verifyToken");
  const search = url.searchParams.toString();
  return `${url.pathname}${search.length > 0 ? `?${search}` : ""}${url.hash}`;
}
