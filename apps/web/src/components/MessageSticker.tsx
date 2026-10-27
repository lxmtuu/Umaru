import type { Sticker } from "@umaru/protocol";
import { useStickerUrl } from "../lib/stickers.js";

/**
 * Sticker trong bong bóng tin.
 *
 * Kích thước cố định (128px) thay vì theo ảnh gốc: sticker là ảnh **vuông** đã
 * được server kiểm, và một lưới tin cần nhịp điệu đều — ảnh 512px làm tin cao
 * gấp ba lần bình thường.
 *
 * Ảnh tải qua Bearer → `blob:` URL (xem `lib/stickers.ts`). Đang tải thì giữ
 * đúng ô 128px để bố cục không nhảy; lỗi thì hiện nhãn chứ không để ô trống.
 */
export function MessageSticker({ sticker }: { sticker: Sticker }) {
  const state = useStickerUrl(sticker.imageUrl);

  if (state.status === "ready") {
    return (
      <img
        src={state.url}
        alt={sticker.name}
        title={sticker.name}
        width={128}
        height={128}
        loading="lazy"
        decoding="async"
        className="mt-1 size-32 select-none"
        draggable={false}
      />
    );
  }

  return (
    <div
      className="mt-1 grid size-32 place-items-center rounded-lg bg-white/5 text-[11px] text-slate-500"
      aria-label={sticker.name}
    >
      {state.status === "loading" ? "…" : "🖼️"}
    </div>
  );
}
