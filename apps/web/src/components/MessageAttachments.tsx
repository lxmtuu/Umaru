import type { Attachment } from "@umaru/protocol";
import { useT } from "../lib/i18n.js";
import { getAccessToken } from "../lib/session.js";
import {
  downloadAttachment,
  formatBytes,
  isImageAttachment,
  useAttachmentUrl,
} from "../lib/attachments.js";

/**
 * Hiển thị tệp đính kèm của một tin nhắn.
 *
 * Ảnh: tải qua fetch kèm Bearer token → blob URL (xem `lib/attachments.ts`),
 * dùng `width`/`height` server đọc từ header để giữ đúng tỉ lệ trước khi ảnh
 * hiện ra (không bị layout nhảy).
 * Tệp khác: chip có tên + dung lượng, bấm để tải về.
 */
function AttachmentImage({ attachment }: { attachment: Attachment }) {
  const url = useAttachmentUrl(attachment, getAccessToken());
  const t = useT();

  if (url.status === "error") {
    return (
      <span className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
        {t("imageFailed", { name: attachment.filename })}
      </span>
    );
  }

  // Khung giữ chỗ theo đúng tỉ lệ: ảnh hiện ra không đẩy nội dung bên dưới.
  const aspectRatio =
    attachment.width !== null && attachment.height !== null
      ? `${attachment.width} / ${attachment.height}`
      : undefined;

  return (
    <a
      href={url.url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={attachment.filename}
      className="block max-w-sm overflow-hidden rounded-lg border border-white/10 bg-slate-900/60"
    >
      {url.status === "ready" ? (
        <img
          src={url.url}
          alt={attachment.filename}
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          className="max-h-80 w-auto max-w-full object-contain"
        />
      ) : (
        <span
          className="block w-56 animate-pulse bg-slate-800/70"
          style={aspectRatio !== undefined ? { aspectRatio } : { height: "9rem" }}
        />
      )}
    </a>
  );
}

function AttachmentFile({ attachment }: { attachment: Attachment }) {
  const t = useT();
  const token = getAccessToken();
  return (
    <button
      type="button"
      onClick={() => void downloadAttachment(attachment, token)}
      title={t("downloadFile", { name: attachment.filename })}
      className="flex max-w-sm items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-left text-xs text-slate-200 hover:border-emerald-400/40 hover:bg-slate-900"
    >
      <span aria-hidden className="text-base">
        📄
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.filename}</span>
        <span className="text-[11px] text-slate-500">
          {formatBytes(attachment.size)} · {attachment.mimeType}
        </span>
      </span>
    </button>
  );
}

export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((attachment) => !isImageAttachment(attachment));

  return (
    <div className="mt-1 flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((attachment) => (
            <AttachmentImage key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-1">
          {files.map((attachment) => (
            <AttachmentFile key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </div>
  );
}
