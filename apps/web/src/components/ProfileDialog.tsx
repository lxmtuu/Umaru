import { useRef } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { Avatar } from "./Avatar.js";

/**
 * Hộp thoại hồ sơ: đổi / gỡ ảnh đại diện.
 *
 * Không dùng `<Modal>` của ChatScreen vì đây không phải form "gửi form" mà là
 * hai hành động độc lập (chọn tệp → tải lên ngay; gỡ → xoá ngay). Tải xong là
 * đóng, không cần bấm "Lưu".
 */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const me = useChat((state) => state.me);
  const uploading = useChat((state) => state.avatarUploading);
  const error = useChat((state) => state.avatarError);
  const uploadAvatar = useChat((state) => state.uploadAvatar);
  const removeAvatar = useChat((state) => state.removeAvatar);
  const clearError = useChat((state) => state.clearAvatarError);
  const inputRef = useRef<HTMLInputElement>(null);
  const notifications = useChat((state) => state.notificationSettings);
  const permission = useChat((state) => state.notificationPermission);
  const setDesktop = useChat((state) => state.setDesktopNotifications);
  const setTabTitle = useChat((state) => state.setTabTitleNotifications);

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const ok = await uploadAvatar(file);
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-10 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-label={t("avatarChange")}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 className="mb-4 text-sm font-semibold">{t("avatarChange")}</h3>

        <div className="mb-4 flex items-center gap-3">
          <Avatar
            avatarUrl={me?.avatarUrl ?? null}
            name={me?.displayName ?? "?"}
            size="size-16"
            textClass="text-xl"
          />
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-100">{me?.displayName}</p>
            <p className="truncate text-xs text-slate-500">@{me?.username}</p>
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          className="hidden"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]).finally(() => {
              // Cho phép chọn lại đúng tệp vừa chọn (sau khi sửa ảnh trên máy).
              if (inputRef.current !== null) inputRef.current.value = "";
            });
          }}
        />

        {error !== null && (
          <p className="mb-3 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
            {error}
          </p>
        )}

        {/* Thông báo: lưu ở máy (localStorage), không có API server nào liên quan. */}
        <div className="mb-4 rounded-lg border border-white/10 p-2.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("notifications")}
          </p>
          <label className="flex items-start gap-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={notifications.desktop}
              disabled={permission === "denied" || permission === "unsupported"}
              onChange={(event) => void setDesktop(event.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">
              {t("notificationsDesktop")}
              <span className="block text-[11px] text-slate-500">
                {permission === "denied"
                  ? t("notificationsBlocked")
                  : permission === "unsupported"
                    ? t("notificationsUnsupported")
                    : t("notificationsDesktopHint")}
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={notifications.tabTitle}
              onChange={(event) => setTabTitle(event.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">{t("notificationsTabTitle")}</span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              clearError();
              inputRef.current?.click();
            }}
            className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50"
          >
            {uploading ? t("avatarUploading") : t("avatarChange")}
          </button>
          {me?.avatarUrl != null && (
            <button
              type="button"
              disabled={uploading}
              onClick={() => {
                void removeAvatar().then((ok) => {
                  if (ok) onClose();
                });
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              {t("avatarRemove")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
