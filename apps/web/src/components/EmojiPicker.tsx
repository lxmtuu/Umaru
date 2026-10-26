import { useEffect, useRef } from "react";

/**
 * Bảng chọn emoji tối giản.
 *
 * Vì sao không dùng thư viện emoji đầy đủ (`emoji-mart` ~200 KB + dữ liệu):
 * 90% tin nhắn dùng đúng vài chục emoji, và bộ chọn chỉ để chèn **ký tự** vào ô
 * soạn. Danh sách dưới đây là emoji dùng nhiều trong nhóm chat, nhóm theo cụm để
 * mắt tìm nhanh. Muốn gõ emoji ngoài danh sách thì dùng bàn phím hệ điều hành
 * (Win+`.`, Ctrl+Cmd+Space) — vẫn chèn vào textarea bình thường.
 *
 * Không dựa vào `Intl`/font: emoji là ký tự Unicode, trình duyệt tự vẽ.
 */

/** Nhóm emoji, nhãn lấy từ i18n ở component cha. */
export interface EmojiGroup {
  label: string;
  emojis: string[];
}

export interface EmojiPickerProps {
  groups: EmojiGroup[];
  /** Nhãn cho screen reader, ví dụ "Bảng emoji". */
  label: string;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ groups, label, onPick, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (ref.current?.contains(event.target as Node) === true) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    // Cuộn trang làm bảng trôi khỏi nút bấm — đóng, giống menu chuột phải.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-testid="emoji-picker"
      className="absolute bottom-full left-0 z-40 mb-2 max-h-64 w-72 overflow-y-auto rounded-lg border border-white/10 bg-[#1e1f22] p-2 shadow-2xl"
    >
      {groups.map((group) => (
        <section key={group.label} className="mb-2 last:mb-0">
          <h3 className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {group.label}
          </h3>
          <div className="grid grid-cols-8 gap-0.5">
            {group.emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                // `aria-label` là ký tự itself để screen reader đọc được tên emoji
                // (trình duyệt đọc tên Unicode của ký tự).
                aria-label={emoji}
                onClick={() => onPick(emoji)}
                className="grid size-8 place-items-center rounded text-lg hover:bg-white/10"
              >
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Bộ emoji mặc định — nhóm theo cách người ta dùng, không theo Unicode block. */
export const DEFAULT_EMOJI_GROUPS: ReadonlyArray<{ key: string; emojis: string[] }> = [
  {
    key: "reactions",
    emojis: ["👍", "👎", "👏", "🙌", "🙏", "🤝", "💪", "✌️", "👀", "🫡", "🤙", "👌", "🖐️", "✋", "🤞", "🫶"],
  },
  {
    key: "faces",
    emojis: ["😀", "😄", "😁", "😅", "😂", "🤣", "🙂", "😉", "😊", "😍", "🥰", "😘", "😎", "🤔", "🤨", "😐", "😴", "😢", "😭", "😤", "😡", "🤯", "🥳", "🤗", "😬", "🤢", "🤒", "😇", "🫠", "🫣", "🫤", "😵‍💫"],
  },
  {
    key: "hearts",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💯", "✨", "🔥", "🎉", "🎊", "⭐", "🌈"],
  },
  {
    key: "work",
    emojis: ["✅", "❌", "⚠️", "❓", "❗", "💡", "📌", "📎", "📝", "🔧", "🐛", "🚀", "⏰", "☕", "🍜", "🍕"],
  },
];
