import type { Embed } from "@umaru/protocol";
import { useState } from "react";

/**
 * Thẻ xem trước liên kết dưới tin nhắn (kiểu embed của Discord).
 *
 * Dữ liệu đã được **server** tải và lưu (`services/api/src/embeds`) — client chỉ
 * hiển thị, không gọi ra trang bên ngoài. Ảnh thì vẫn do trình duyệt tải trực
 * tiếp từ máy chủ của trang đó (giống Discord bản không qua proxy): `loading="lazy"`
 * để không tải ảnh của cả cuộn hội thoại, `referrerPolicy="no-referrer"` để
 * không lộ URL phòng chat cho bên thứ ba.
 */
function EmbedImage({ src }: { src: string }) {
  // Ảnh chết (404, chặn hotlink) → bỏ khung ảnh, giữ phần chữ. Không để icon vỡ.
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-h-64 w-full object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function EmbedCard({ embed }: { embed: Embed }) {
  let host = embed.siteName ?? "";
  if (host === "") {
    try {
      host = new URL(embed.url).hostname;
    } catch {
      host = embed.url;
    }
  }

  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-md overflow-hidden rounded-lg border border-white/10 bg-slate-900/60 transition-colors hover:border-white/20 hover:bg-slate-800/60"
    >
      {embed.imageUrl !== null && embed.imageUrl !== "" ? <EmbedImage src={embed.imageUrl} /> : null}
      <div className="border-l-2 border-indigo-400/70 px-3 py-2">
        {host !== "" ? (
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {host}
          </div>
        ) : null}
        {embed.title !== null && embed.title !== "" ? (
          <div className="text-sm font-semibold text-indigo-200">{embed.title}</div>
        ) : null}
        {embed.description !== null && embed.description !== "" ? (
          <div className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-xs text-slate-300">
            {embed.description}
          </div>
        ) : null}
        <div className="mt-1 truncate text-[11px] text-slate-500">{embed.url}</div>
      </div>
    </a>
  );
}

/** Rỗng/không có thì không render gì — tin thường không tốn thêm node nào. */
export function MessageEmbeds({ embeds }: { embeds: Embed[] | undefined }) {
  if (embeds === undefined || embeds.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {embeds.map((embed) => (
        <EmbedCard key={embed.url} embed={embed} />
      ))}
    </div>
  );
}
