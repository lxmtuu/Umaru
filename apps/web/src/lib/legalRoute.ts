import type { LegalDocId, LegalLocale } from "./legal.js";

/**
 * Nhận diện trang pháp lý từ URL.
 *
 * App không dùng router (một màn hình chat duy nhất), nên chỉ cần nhận đúng
 * hai đường dẫn tĩnh `/terms` và `/privacy`. Nhờ vậy link trong email, trong
 * phụ lục hợp đồng hay trên app store đều mở được **khi chưa đăng nhập**.
 *
 * Chấp nhận cả `/terms/` và tiền tố tuỳ chọn (`/vi/terms` không hỗ trợ — ngôn
 * ngữ chọn bằng `?lang=`).
 */
export function readLegalRoute(pathname: string): LegalDocId | null {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  if (normalized === "/terms") return "terms";
  if (normalized === "/privacy") return "privacy";
  return null;
}

/** `?lang=en|vi` trên URL; không hợp lệ thì dùng ngôn ngữ đang chọn. */
export function readLegalLocale(search: string, fallback: LegalLocale): LegalLocale {
  const requested = new URLSearchParams(search).get("lang");
  return requested === "en" || requested === "vi" ? requested : fallback;
}

/** Đường dẫn mở một văn bản, giữ ngôn ngữ trên URL để chia sẻ được. */
export function legalPath(doc: LegalDocId, locale: LegalLocale): string {
  return `/${doc}?lang=${locale}`;
}
