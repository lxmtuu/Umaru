import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Menu chuột phải (giống menu ngữ cảnh của Discord).
 *
 * Bốn thứ dễ hỏng ở một menu chuột phải, và đây là cách xử lý:
 *
 * 1. **Tràn khỏi màn hình.** Mở gần cạnh phải/dưới thì menu bị cắt mất. Đo kích
 *    thước thật rồi lật về phía còn chỗ (`useLayoutEffect`, trước khi vẽ xong nên
 *    không thấy nhấp nháy).
 * 2. **Không đóng.** Phải đóng khi: bấm ra ngoài, `Escape`, cuộn, đổi kích thước
 *    cửa sổ, và khi mở menu khác. Cuộn mà không đóng thì menu "trôi" khỏi chỗ
 *    người dùng vừa bấm.
 * 3. **Không dùng được bằng bàn phím.** `ArrowUp/ArrowDown/Home/End` di chuyển
 *    giữa các mục, `Escape` đóng, `Enter`/`Space` (nút native) chọn.
 * 4. **Bị cắt bởi `overflow: hidden` của khung cha.** Vì vậy render qua portal
 *    vào `document.body` và dùng `position: fixed`.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Emoji/icon ngắn đặt trước nhãn — không dùng ảnh để menu nhẹ và tức thì. */
  icon?: string;
  /** Hành động phá huỷ (xoá, chặn): chữ đỏ để không bấm nhầm. */
  danger?: boolean;
  onSelect: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Nhãn cho screen reader, ví dụ "Hành động với tin nhắn". */
  label: string;
  onClose: () => void;
}

/** Khoảng cách tối thiểu tới mép màn hình khi phải lật menu. */
const VIEWPORT_MARGIN = 8;

export function ContextMenu({ x, y, items, label, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
      left = Math.max(VIEWPORT_MARGIN, x - rect.width);
    }
    if (top + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
      top = Math.max(VIEWPORT_MARGIN, y - rect.height);
    }
    // So sánh trước khi set: `setState` trong layout effect mà không kiểm sẽ
    // thành vòng lặp vô hạn (mỗi lần set lại đo lại).
    setPosition((current) => (current.left === left && current.top === top ? current : { left, top }));
    element.querySelector<HTMLButtonElement>("button[role='menuitem']")?.focus();
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (ref.current?.contains(event.target as Node) === true) return;
      onClose();
    }
    function onContextMenuOutside(event: MouseEvent): void {
      if (ref.current?.contains(event.target as Node) === true) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? [],
      );
      if (buttons.length === 0) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % buttons.length;
      else next = index <= 0 ? buttons.length - 1 : index - 1;
      buttons[next]?.focus();
    }
    function onViewportChange(): void {
      onClose();
    }

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenuOutside, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    // `capture` để bắt cả khi cuộn bên trong khung tin nhắn, không chỉ cuộn trang.
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenuOutside, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid="context-menu"
      style={{ left: position.left, top: position.top }}
      className="fixed z-50 min-w-48 rounded-lg border border-white/10 bg-[#1e1f22] py-1 shadow-2xl"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            // Đóng **trước** rồi mới chạy hành động: hành động có thể mở hộp
            // thoại khác, và menu cũ còn trên màn hình là chuyện khó hiểu.
            onClose();
            item.onSelect();
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/10 ${
            item.danger ? "text-rose-300 hover:bg-rose-500/20" : "text-slate-200"
          }`}
        >
          <span aria-hidden className="w-4 shrink-0 text-center text-xs">
            {item.icon ?? ""}
          </span>
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
