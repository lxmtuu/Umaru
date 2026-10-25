import { useEffect, useState } from "react";
import { authedApi } from "./session.js";

/**
 * Tải avatar kèm Bearer token rồi dựng `blob:` URL — cùng lý do với tệp đính
 * kèm (`lib/attachments.ts`): token không được nằm trong URL.
 *
 * Cache theo `avatarUrl` là đủ vì URL chứa `uploadId`: đổi avatar = URL mới.
 * Vì vậy ảnh cũ không bao giờ hiện lại, và không cần "xoá cache" khi đổi.
 */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

export async function fetchAvatarObjectUrl(avatarUrl: string): Promise<string> {
  const cached = cache.get(avatarUrl);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(avatarUrl);
  if (pending !== undefined) return pending;

  const request = authedApi
    .fetchAvatar(avatarUrl)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      cache.set(avatarUrl, url);
      return url;
    })
    .finally(() => {
      inFlight.delete(avatarUrl);
    });

  inFlight.set(avatarUrl, request);
  return request;
}

/** Xoá toàn bộ object URL (gọi khi đăng xuất). */
export function clearAvatarCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inFlight.clear();
}

export type AvatarUrlState =
  | { status: "idle"; url: null }
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null };

/**
 * `avatarUrl` null = người này chưa đặt avatar → `status: "idle"` để component
 * hiển thị chữ cái đầu ngay, không chờ mạng.
 */
export function useAvatarUrl(avatarUrl: string | null): AvatarUrlState {
  const [state, setState] = useState<AvatarUrlState>(
    avatarUrl === null ? { status: "idle", url: null } : { status: "loading", url: null },
  );

  useEffect(() => {
    if (avatarUrl === null) {
      setState({ status: "idle", url: null });
      return;
    }
    let active = true;
    setState({ status: "loading", url: null });
    fetchAvatarObjectUrl(avatarUrl)
      .then((url) => {
        if (active) setState({ status: "ready", url });
      })
      .catch(() => {
        if (active) setState({ status: "error", url: null });
      });
    return () => {
      active = false;
    };
  }, [avatarUrl]);

  return state;
}

/** Chỉ ảnh raster — khớp allowlist ở server (`AVATAR_MIME_TYPES`). */
export const AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** Trần ảnh đại diện — khớp `MAX_AVATAR_BYTES` của services/api. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Kiểm tra ảnh trước khi tải lên (server vẫn kiểm lại magic bytes).
 * Trả khoá i18n của lỗi, hoặc null nếu hợp lệ.
 */
export function validateAvatar(file: File): "avatarTypeBlocked" | "avatarTooLarge" | null {
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!AVATAR_MIME_TYPES.has(mime)) return "avatarTypeBlocked";
  if (file.size > MAX_AVATAR_BYTES) return "avatarTooLarge";
  if (file.size === 0) return "avatarTypeBlocked";
  return null;
}
