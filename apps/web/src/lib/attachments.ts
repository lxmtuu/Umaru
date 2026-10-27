import type { Attachment } from "@umaru/protocol";
import { useEffect, useState } from "react";
import { translate } from "./i18n.js";
import { authedApi } from "./session.js";

/**
 * Tải nội dung tệp đính kèm kèm Bearer token rồi dựng `blob:` URL.
 *
 * Vì sao không đặt `<img src="/api/v1/attachments/...">` trực tiếp: endpoint cần
 * header Authorization, mà token nằm trong URL thì lọt vào log/referrer/lịch sử.
 * Cache theo cặp (attachmentId, token) để cuộn lại không tải lần hai; đổi tài
 * khoản (token khác) là cache cũ không dùng lại được nên key phải đổi theo.
 */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function keyOf(attachmentId: string, token: string | null): string {
  return `${token ?? "anon"}|${attachmentId}`;
}

/** `fetchAttachmentObjectUrl` dùng chung cho ảnh và nút tải tệp. */
export async function fetchAttachmentObjectUrl(
  attachmentId: string,
  token: string | null,
): Promise<string> {
  const key = keyOf(attachmentId, token);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const request = authedApi
    .fetchAttachment(attachmentId)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      cache.set(key, url);
      return url;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

/** Xoá toàn bộ object URL (gọi khi đăng xuất để trả bộ nhớ). */
export function clearAttachmentCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inFlight.clear();
}

export type AttachmentUrlState =
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "error"; url: null };

export function useAttachmentUrl(
  attachment: Attachment,
  token: string | null,
): AttachmentUrlState {
  const [state, setState] = useState<AttachmentUrlState>({ status: "loading", url: null });

  useEffect(() => {
    let active = true;
    setState({ status: "loading", url: null });
    fetchAttachmentObjectUrl(attachment.id as string, token)
      .then((url) => {
        if (active) setState({ status: "ready", url });
      })
      .catch(() => {
        if (active) setState({ status: "error", url: null });
      });
    return () => {
      active = false;
    };
  }, [attachment.id, token]);

  return state;
}

/** Tải file về máy (dùng blob URL đã cache, không mở tab trống). */
export async function downloadAttachment(
  attachment: Attachment,
  token: string | null,
): Promise<void> {
  const url = await fetchAttachmentObjectUrl(attachment.id as string, token);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageAttachment(attachment: Attachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

/** Phải khớp `MAX_FILES_PER_MESSAGE` / trần MIME của services/api. */
export const MAX_FILES_PER_MESSAGE = 4;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Định dạng được phép — giống allowlist ở server. Kiểm ở client chỉ để báo lỗi
 * ngay lập tức; server vẫn là nơi quyết định (client không tin được).
 */
export const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
  "application/x-7z-compressed",
  "application/gzip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * Lọc danh sách tệp người dùng chọn: bỏ tệp sai định dạng/quá lớn, cắt theo số
 * lượng tối đa, trả về lỗi đầu tiên gặp phải để hiện ngay dưới ô soạn.
 */
export function validateFiles(
  incoming: File[],
  existing: File[],
): { accepted: File[]; error: string | null } {
  const accepted: File[] = [...existing];
  let error: string | null = null;

  for (const file of incoming) {
    const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      error ??= translate("fileTypeBlocked", { name: file.name });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      error ??= translate("fileTooLarge", { name: file.name });
      continue;
    }
    if (accepted.length >= MAX_FILES_PER_MESSAGE) {
      error ??= translate("filesTooMany", { count: MAX_FILES_PER_MESSAGE });
      break;
    }
    // Cùng tên + cùng dung lượng coi như một tệp, tránh đính kèm trùng.
    if (accepted.some((item) => item.name === file.name && item.size === file.size)) continue;
    accepted.push(file);
  }

  return { accepted, error };
}
