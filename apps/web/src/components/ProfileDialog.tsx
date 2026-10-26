import { useRef } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { pushHintKey } from "../lib/push.js";
import { Avatar } from "./Avatar.js";
import { PRESENCE_DOT } from "../lib/presence.js";
import type { PresenceStatus } from "@umaru/protocol";

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
  const pushStatus = useChat((state) => state.pushStatus);
  const pushBusy = useChat((state) => state.pushBusy);
  const pushNotice = useChat((state) => state.pushNotice);
  const enablePush = useChat((state) => state.enablePush);
  const disablePush = useChat((state) => state.disablePush);
  const testPush = useChat((state) => state.testPush);
  const selfStatus = useChat((state) => state.selfStatus);
  const setPresence = useChat((state) => state.setPresence);
  const display = useChat((state) => state.displaySettings);
  const setCompactMode = useChat((state) => state.setCompactMode);

  // Thứ tự như Discord: Trực tuyến → Đang chờ → Không làm phiền → Ẩn.
  const statuses: Array<{ status: PresenceStatus; label: string }> = [
    { status: "online", label: t("statusOnline") },
    { status: "idle", label: t("statusIdle") },
    { status: "dnd", label: t("statusDnd") },
    { status: "offline", label: t("statusInvisible") },
  ];

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

        {/* Trạng thái hiển thị: đổi là gửi ngay qua gateway, không cần bấm Lưu. */}
        <fieldset className="mb-4 rounded-lg border border-white/10 p-2.5">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("myStatus")}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {statuses.map((option) => (
              <button
                key={option.status}
                type="button"
                onClick={() => setPresence(option.status)}
                aria-pressed={selfStatus === option.status}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                  selfStatus === option.status
                    ? "bg-white/10 text-slate-100 ring-1 ring-emerald-400/40"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <span className={`size-2 rounded-full ${PRESENCE_DOT[option.status]}`} aria-hidden />
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

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

        {/*
          Hiển thị: tuỳ chọn theo **máy** (localStorage), không phải theo tài
          khoản — điện thoại thích gọn còn màn hình lớn thích thoáng.
        */}
        <div className="mb-4 rounded-lg border border-white/10 p-2.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("display")}
          </p>
          <label className="flex items-start gap-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={display.compact}
              onChange={(event) => setCompactMode(event.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">
              {t("compactMode")}
              <span className="block text-[11px] text-slate-500">{t("compactModeHint")}</span>
            </span>
          </label>
        </div>

        {/*
          Thông báo đẩy khi đã đóng tab — cần service worker + VAPID ở server.
          Hộp kiểm **không** bị vô hiệu hoá chỉ vì trình duyệt chặn: người dùng
          vẫn cần thấy lý do và đường sửa (bấm vào sẽ hiện gợi ý tương ứng).
        */}
        <div className="mb-4 rounded-lg border border-white/10 p-2.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("pushTitle")}
          </p>
          <label className="flex items-start gap-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={pushStatus === "on"}
              disabled={pushBusy || pushStatus === "unsupported" || pushStatus === "unavailable"}
              onChange={(event) => void (event.target.checked ? enablePush() : disablePush())}
              className="mt-0.5 accent-emerald-400"
            />
            <span className="flex-1">
              {pushStatus === "on" ? t("pushDisable") : t("pushEnable")}
              <span className="block text-[11px] text-slate-500">
                {t(pushHintKey(pushStatus))}
              </span>
            </span>
          </label>
          {pushStatus === "on" && (
            <button
              type="button"
              disabled={pushBusy}
              onClick={() => void testPush()}
              className="mt-2 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              {pushBusy ? t("pushBusy") : t("pushSendTest")}
            </button>
          )}
          {pushNotice !== null && (
            <p className="mt-1.5 text-[11px] text-slate-400">{pushNotice}</p>
          )}
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
