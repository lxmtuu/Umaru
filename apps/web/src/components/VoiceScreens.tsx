import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n.js";
import type { VoiceScreenShare } from "../lib/voice.js";

/**
 * Khung xem chia sẻ màn hình của người khác trong phòng thoại đang ở.
 *
 * Thẻ `<video>` do LiveKit tạo và đã gắn luồng media (`track.attach()`), nên
 * React **không tạo** phần tử đó — chỉ đưa nó vào cây DOM. Vì vậy mỗi tile dùng
 * một `div` chủ và `append` trong `useEffect`; render lại không làm mất hình vì
 * cùng một phần tử được giữ nguyên.
 *
 * Vị trí: nổi ở góc dưới phải, không chiếm chỗ của khung chat. Người dùng đang
 * đọc tin không bị đẩy nội dung sang một bên chỉ vì có ai đó bật chia sẻ.
 */
export function VoiceScreens({ screens }: { screens: VoiceScreenShare[] }) {
  if (screens.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-20 flex w-[min(48vw,720px)] flex-col gap-2">
      {screens.map((screen) => (
        <ScreenTile key={screen.id} screen={screen} />
      ))}
    </div>
  );
}

function ScreenTile({ screen }: { screen: VoiceScreenShare }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.append(screen.element);
    // `play()` có thể bị từ chối nếu chưa có thao tác người dùng; khi đó trình
    // duyệt hiện nút play và người dùng bấm một lần là xong — không phải lỗi.
    void screen.element.play().catch(() => undefined);
    return () => {
      screen.element.remove();
    };
  }, [screen.element]);

  return (
    <figure className="pointer-events-auto overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">
      <div
        ref={hostRef}
        className="flex aspect-video w-full items-center justify-center bg-black [&>video]:h-full [&>video]:w-full"
      />
      <figcaption className="flex items-center gap-1.5 truncate bg-slate-900/90 px-2 py-1 text-[11px] text-slate-300">
        <span className="truncate font-semibold text-emerald-200">{screen.label}</span>
        <span className="shrink-0 text-slate-500">{t("voiceScreenSharing")}</span>
      </figcaption>
    </figure>
  );
}
