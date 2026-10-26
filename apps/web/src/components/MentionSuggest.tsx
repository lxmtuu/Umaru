import { Avatar } from "./Avatar.js";

/**
 * Danh sách gợi ý khi gõ `@` trong ô soạn tin.
 *
 * Chỉ là phần **hiển thị**: phím và vị trí chèn do `ChatScreen` xử lý (nó đang
 * giữ giá trị ô soạn). Component nhận `activeIndex` để cùng một trạng thái được
 * dùng cho cả bàn phím lẫn chuột — hai nguồn riêng sẽ lệch nhau ngay.
 */
export interface MentionSuggestItem {
  /** Khoá duy nhất trong danh sách (`user:<id>` / `role:<id>`). */
  userId: string;
  /** Chữ được chèn vào ô soạn (username, hoặc **tên role**). */
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** `true` = gợi ý **role** (hiện dấu `@` màu role thay cho avatar). */
  role?: boolean;
  /** Màu role (0xRRGGBB); 0 = chưa đặt màu. */
  color?: number;
}

export interface MentionSuggestProps {
  id: string;
  items: MentionSuggestItem[];
  activeIndex: number;
  label: string;
  /** Nhãn cạnh gợi ý role ("nhóm"/"role") — người dùng phải biết mình sắp ping cả nhóm. */
  roleLabel?: string;
  onPick: (item: MentionSuggestItem) => void;
  onHover: (index: number) => void;
}

export function MentionSuggest({
  id,
  items,
  activeIndex,
  label,
  roleLabel = "role",
  onPick,
  onHover,
}: MentionSuggestProps) {
  if (items.length === 0) return null;
  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      data-testid="mention-suggest"
      className="absolute bottom-full left-0 z-40 mb-1 w-64 overflow-hidden rounded-lg border border-white/10 bg-[#1e1f22] py-1 shadow-2xl"
    >
      {items.map((item, index) => (
        <button
          key={item.userId}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          // `onMouseDown` chứ không `onClick`: bấm vào gợi ý làm textarea mất
          // focus trước khi `click` bắn ra, và một số trình duyệt huỷ click khi
          // focus đổi — chọn bằng `mousedown` là chắc chắn nhất.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(index)}
          className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${
            index === activeIndex ? "bg-emerald-400/15 text-emerald-100" : "text-slate-200"
          }`}
        >
          {item.role === true ? (
            // Role không có avatar: dấu `@` màu role để phân biệt bằng mắt với người.
            <span
              aria-hidden
              className="grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-bold"
              style={item.color !== undefined && item.color !== 0 ? { color: `#${item.color.toString(16).padStart(6, "0")}` } : undefined}
            >
              @
            </span>
          ) : (
            <Avatar
              avatarUrl={item.avatarUrl}
              name={item.displayName}
              size="size-5"
              textClass="text-[10px]"
            />
          )}
          <span className="min-w-0 truncate font-medium">{item.displayName}</span>
          {/*
            Người: hiện `@username` (đúng chữ sẽ được chèn). Role: hiện nhãn
            "role" — người dùng phải biết mình sắp ping **cả một nhóm** chứ không
            phải một người, hai thứ này khác nhau về hậu quả.
          */}
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
            {item.role === true ? roleLabel : `@${item.username}`}
          </span>
        </button>
      ))}
    </div>
  );
}
