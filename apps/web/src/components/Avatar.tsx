import { useAvatarUrl } from "../lib/avatars.js";

export interface AvatarProps {
  avatarUrl: string | null | undefined;
  /** Dùng cho chữ cái đầu khi chưa có ảnh và cho `alt`. */
  name: string;
  /** Kích thước cạnh (tailwind) — mặc định `size-6`. */
  size?: string;
  /** Cỡ chữ của chữ cái đầu — mặc định `text-[11px]`. */
  textClass?: string;
  className?: string;
}

/**
 * Ảnh đại diện. Chưa có ảnh (hoặc đang tải) → chữ cái đầu trên nền xám, nên
 * bố cục không nhảy khi ảnh về. Ảnh được tải qua fetch + Bearer rồi dựng blob
 * URL, nên không lộ token trong `<img src>`.
 */
export function Avatar({
  avatarUrl,
  name,
  size = "size-6",
  textClass = "text-[11px]",
  className = "",
}: AvatarProps) {
  const state = useAvatarUrl(avatarUrl ?? null);
  const initial = name.slice(0, 1).toUpperCase() || "?";

  return (
    <span
      className={`grid ${size} shrink-0 place-items-center overflow-hidden rounded-full bg-slate-700 ${textClass} ${className}`}
    >
      {state.status === "ready" ? (
        <img src={state.url} alt={name} className="size-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}
