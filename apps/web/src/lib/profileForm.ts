import type { User } from "@umaru/protocol";

/**
 * Phần thuần của form hồ sơ (mục 53): chuẩn hoá và so sánh **trước khi** gửi.
 *
 * Tách khỏi component để kiểm được các ca khó bằng vitest, và để giới hạn ký tự
 * chỉ nằm ở một chỗ — component chỉ hiển thị bộ đếm, không tự cắt chuỗi.
 */

/** Khớp `MAX_BIO_LENGTH` ở server và `CHECK` trong migration 0022. */
export const MAX_BIO_LENGTH = 190;
export const MAX_PRONOUNS_LENGTH = 40;

/** Bảng màu gợi ý — chọn nhanh thay vì bắt người dùng gõ mã hex. */
export const BANNER_COLORS = [
  "#5865f2",
  "#3ba55c",
  "#faa61a",
  "#ed4245",
  "#eb459e",
  "#9b59b6",
  "#0ea5e9",
  "#64748b",
] as const;

export interface ProfileDraft {
  bio: string;
  pronouns: string;
  bannerColor: string;
}

/** Hồ sơ hiện tại → giá trị khởi tạo cho form (`null` thành chuỗi rỗng). */
export function draftFromUser(
  user: Pick<User, "bio" | "pronouns" | "bannerColor"> | null,
): ProfileDraft {
  return {
    bio: user?.bio ?? "",
    pronouns: user?.pronouns ?? "",
    bannerColor: user?.bannerColor ?? "",
  };
}

/**
 * Chỉ gửi trường **đã đổi**. Gửi cả ba trường mỗi lần thì hai tab sửa hai
 * trường khác nhau sẽ ghi đè lẫn nhau (tab A lưu giới thiệu, tab B vừa mở form
 * từ trước lưu đại từ → giới thiệu về giá trị cũ).
 *
 * So sánh sau khi cắt khoảng trắng vì server cũng cắt — "  abc " và "abc" là
 * cùng một giá trị, gửi đi chỉ tốn một vòng mạng và một lần phát `USER_UPDATE`.
 */
export function buildProfilePatch(
  draft: ProfileDraft,
  original: ProfileDraft,
): { bio?: string | null; pronouns?: string | null; bannerColor?: string | null } {
  const patch: { bio?: string | null; pronouns?: string | null; bannerColor?: string | null } = {};

  const bio = draft.bio.trim();
  if (bio !== original.bio.trim()) patch.bio = bio.length === 0 ? null : bio;

  const pronouns = draft.pronouns.trim();
  if (pronouns !== original.pronouns.trim()) {
    patch.pronouns = pronouns.length === 0 ? null : pronouns;
  }

  const color = draft.bannerColor.trim().toLowerCase();
  if (color !== original.bannerColor.trim().toLowerCase()) {
    patch.bannerColor = color.length === 0 ? null : color;
  }

  return patch;
}

/** Không có gì để lưu → nút Lưu tắt. */
export function isPatchEmpty(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length === 0;
}

/**
 * Màu banner để tô: hồ sơ chưa đặt thì dùng màu mặc định của app.
 *
 * Kiểm lại định dạng ở **client** dù server đã kiểm: dữ liệu cũ hoặc một bản
 * build lệch có thể chứa chuỗi lạ, mà giá trị này đi thẳng vào `style`.
 */
export function bannerColorOf(
  profile: { bannerColor?: string | null } | null,
  fallback = "#5865f2",
): string {
  const color = profile?.bannerColor ?? null;
  if (color === null || !/^#[0-9a-f]{6}$/i.test(color)) return fallback;
  return color.toLowerCase();
}

/** `#5865f2` → chữ trắng hay đen? Theo độ sáng tương đối (WCAG). */
export function readableTextOn(hex: string): "#ffffff" | "#0f172a" {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "5865f2";
  const channel = (offset: number): number => parseInt(value.slice(offset, offset + 2), 16) / 255;
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(channel(0)) + 0.7152 * lin(channel(2)) + 0.0722 * lin(channel(4));
  return luminance > 0.5 ? "#0f172a" : "#ffffff";
}

/**
 * Đếm ký tự theo **code point** như server (`char_length` của PostgreSQL cũng
 * đếm theo ký tự), không theo `string.length` của JS — một emoji cờ là 2 đơn vị
 * UTF-16 nhưng 1 ký tự; đếm sai thì bộ đếm hiện "190/190" mà server vẫn nhận.
 */
export function characterCount(text: string): number {
  return [...text.trim()].length;
}

/** Hai bản nháp coi là "cùng một hồ sơ" hay không (đã chuẩn hoá như khi gửi). */
export function sameDraft(a: ProfileDraft, b: ProfileDraft): boolean {
  return (
    a.bio.trim() === b.bio.trim() &&
    a.pronouns.trim() === b.pronouns.trim() &&
    a.bannerColor.trim().toLowerCase() === b.bannerColor.trim().toLowerCase()
  );
}
