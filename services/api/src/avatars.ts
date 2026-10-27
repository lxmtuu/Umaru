/**
 * Tiện ích avatar người dùng.
 *
 * URL công khai (trong phạm vi đã đăng nhập) chứa `uploadId`:
 *
 *   /api/v1/users/{userId}/avatar/{uploadId}
 *
 * Nhờ vậy đổi avatar = đổi URL → client/trình duyệt không bao giờ hiện ảnh cũ
 * đã cache, và server được phép trả `cache-control: immutable`.
 *
 * File nằm ở `avatarsDir` (mặc định `<UPLOADS_DIR>/avatars`), **tách khỏi**
 * thư mục tệp đính kèm để thao tác dọn tệp của tin nhắn không chạm vào avatar.
 */

/** Chỉ ảnh raster — SVG/HTML chứa được script nên không cho làm avatar. */
export const AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function isAvatarMime(mime: string): boolean {
  return AVATAR_MIME_TYPES.has(mime.toLowerCase().split(";")[0]?.trim() ?? "");
}

/** Đường dẫn API của avatar; `uploadId` null (chưa có avatar) → null. */
export function avatarUrl(userId: string, uploadId: string | number | null): string | null {
  if (uploadId === null) return null;
  return `/api/v1/users/${userId}/avatar/${uploadId}`;
}
