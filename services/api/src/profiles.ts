import type { PublicProfile, User } from "@umaru/protocol";
import { HttpError } from "./http.js";

/**
 * Hồ sơ công khai: giới thiệu, đại từ, màu banner.
 *
 * Tách khỏi `routes.ts` để kiểm được phần *thuần* (chuẩn hoá, chặn rác) mà
 * không cần Postgres, và để cả `PATCH` lẫn `USER_UPDATE` dùng cùng một cách
 * chuẩn hoá — nếu không, client nhận về `"  "` qua REST nhưng `null` qua
 * gateway là chuyện có thật.
 */

/** Trần ký tự, khớp `CHECK` trong migration 0022. */
export const MAX_BIO_LENGTH = 190;
export const MAX_PRONOUNS_LENGTH = 40;

/** Màu banner hợp lệ: `#rrggbb` chữ thường. Khớp `CHECK users_banner_color_format`. */
const BANNER_COLOR = /^#[0-9a-f]{6}$/;

export interface ProfilePatch {
  bio: string | null;
  pronouns: string | null;
  bannerColor: string | null;
}

/**
 * Chuẩn hoá một giá trị chuỗi người dùng gửi lên.
 *
 * - `undefined`/thiếu trường → giữ nguyên giá trị cũ (undefined ở đầu ra để
 *   route biết là "không đổi").
 * - `null` → xoá.
 * - Chuỗi chỉ có khoảng trắng → coi như xoá: gửi `"   "` mà lưu vào DB thì hồ
 *   sơ hiện khoảng trống, người dùng tưởng đã xoá.
 * - Cắt khoảng trắng hai đầu **trước** khi đo độ dài, để `"a".repeat(190) + " "`
 *   không bị từ chối vì một dấu cách vô nghĩa.
 */
function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} phải là chuỗi hoặc null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      `${field} tối đa ${max} ký tự (hiện ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Đọc và kiểm phần thân `PATCH /users/@me/profile`.
 *
 * Trường lạ bị **bỏ qua** chứ không báo lỗi: client cũ/mới lệch nhau một trường
 * thì không nên làm hỏng cả lần lưu.
 */
export function parseProfilePatch(body: unknown): Partial<ProfilePatch> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_INPUT", "Cần gửi object JSON");
  }
  const input = body as Record<string, unknown>;
  const patch: Partial<ProfilePatch> = {};

  const bio = optionalText(input.bio, "Giới thiệu", MAX_BIO_LENGTH);
  if (bio !== undefined) patch.bio = bio;

  const pronouns = optionalText(input.pronouns, "Đại từ", MAX_PRONOUNS_LENGTH);
  if (pronouns !== undefined) patch.pronouns = pronouns;

  if (input.bannerColor !== undefined) {
    if (input.bannerColor === null) {
      patch.bannerColor = null;
    } else if (typeof input.bannerColor !== "string") {
      throw new HttpError(400, "INVALID_INPUT", "Màu banner phải là chuỗi hoặc null");
    } else {
      const color = input.bannerColor.trim().toLowerCase();
      // Chuỗi rỗng = "bỏ màu", giống cách xử lý bio/pronouns.
      if (color.length === 0) {
        patch.bannerColor = null;
      } else if (!BANNER_COLOR.test(color)) {
        throw new HttpError(400, "INVALID_INPUT", "Màu banner phải có dạng #rrggbb");
      } else {
        patch.bannerColor = color;
      }
    }
  }

  return patch;
}

/**
 * Phần hồ sơ gửi kèm `USER_UPDATE`.
 *
 * Chỉ ba trường công khai + avatar/tên; **không** email, không ngày tạo, không
 * `status` (presence là ephemeral, bịa "online" ở đây là sai).
 */
export function profileUpdateFields(row: {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  pronouns: string | null;
  banner_color: string | null;
}): Pick<User, "id" | "username" | "displayName" | "avatarUrl" | "bio" | "pronouns" | "bannerColor"> {
  return {
    id: row.id as User["id"],
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: normalizeStored(row.bio),
    pronouns: normalizeStored(row.pronouns),
    bannerColor: normalizeStored(row.banner_color),
  };
}

/** DB có thể chứa `""` từ trước khi có ràng buộc; ra ngoài luôn quy về `null`. */
function normalizeStored(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Dựng `PublicProfile` từ hàng `users`. */
export function toPublicProfile(row: {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  pronouns: string | null;
  banner_color: string | null;
  created_at: Date;
}): PublicProfile {
  return {
    id: row.id as PublicProfile["id"],
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: normalizeStored(row.bio),
    pronouns: normalizeStored(row.pronouns),
    bannerColor: normalizeStored(row.banner_color),
    createdAt: row.created_at.toISOString(),
  };
}
