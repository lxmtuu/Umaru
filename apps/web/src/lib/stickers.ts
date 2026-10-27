import { Permission, hasPermission } from "@umaru/protocol";
import { useEffect, useState } from "react";
import { authedApi } from "./session.js";

/**
 * Sticker phía client: tải ảnh qua Bearer + vài kiểm tra thuần.
 *
 * Cùng lý do với avatar (`lib/avatars.ts`): nội dung của server kín không được
 * nằm sau một `<img src>` công khai, nên ảnh đi qua fetch kèm token rồi dựng
 * `blob:` URL. Cache theo `imageUrl` — URL chứa `stickerId` nên nội dung bất biến.
 */

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

/** Trần ảnh sticker — khớp `MAX_STICKER_BYTES` của services/api. */
export const MAX_STICKER_BYTES = 512 * 1024;

/** Khớp `STICKER_MIME_TYPES` của server (không SVG). */
export const STICKER_MIME_TYPES = new Set([
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export async function fetchStickerObjectUrl(imageUrl: string): Promise<string> {
  const cached = cache.get(imageUrl);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(imageUrl);
  if (pending !== undefined) return pending;

  const request = authedApi
    .fetchSticker(imageUrl)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      cache.set(imageUrl, url);
      return url;
    })
    .finally(() => {
      inFlight.delete(imageUrl);
    });

  inFlight.set(imageUrl, request);
  return request;
}

/** Xoá object URL (gọi khi đăng xuất — cùng chỗ với `clearAvatarCache`). */
export function clearStickerCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inFlight.clear();
}

export type StickerUrlState =
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null };

export function useStickerUrl(imageUrl: string): StickerUrlState {
  const [state, setState] = useState<StickerUrlState>({ status: "loading", url: null });

  useEffect(() => {
    let active = true;
    setState({ status: "loading", url: null });
    fetchStickerObjectUrl(imageUrl)
      .then((url) => {
        if (active) setState({ status: "ready", url });
      })
      .catch(() => {
        if (active) setState({ status: "error", url: null });
      });
    return () => {
      active = false;
    };
  }, [imageUrl]);

  return state;
}

/**
 * Ai được tạo/xoá gói sticker: `MANAGE_EXPRESSIONS`, hoặc ADMINISTRATOR/owner
 * (`resolvePermissions` đã trả ALL cho hai nhánh sau, nên một phép kiểm là đủ).
 */
export function canManageStickers(permissions: bigint | null): boolean {
  if (permissions === null) return false;
  return (
    hasPermission(permissions, Permission.MANAGE_EXPRESSIONS) ||
    hasPermission(permissions, Permission.ADMINISTRATOR)
  );
}

/**
 * Kiểm tra ảnh trước khi tải lên (server vẫn kiểm magic bytes và tỉ lệ vuông).
 * Trả khoá i18n của lỗi, `null` nếu hợp lệ.
 */
export function validateSticker(
  file: File,
): "stickerTypeBlocked" | "stickerTooLarge" | "stickerFileEmpty" | null {
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!STICKER_MIME_TYPES.has(mime)) return "stickerTypeBlocked";
  if (file.size === 0) return "stickerFileEmpty";
  if (file.size > MAX_STICKER_BYTES) return "stickerTooLarge";
  return null;
}

/** Tên mặc định khi người dùng chọn tệp: bỏ đuôi, thay `_`/`-` bằng khoảng trắng. */
export function defaultStickerName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return [...base].slice(0, 40).join("") || "sticker";
}
