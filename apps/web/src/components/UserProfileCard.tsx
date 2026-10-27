import { useEffect, useState } from "react";
import type { PublicProfile } from "@umaru/protocol";
import { useLocale, useT } from "../lib/i18n.js";
import { ApiError } from "@umaru/sdk";
import { authedApi } from "../lib/session.js";
import { bannerColorOf } from "../lib/profileForm.js";
import { Avatar } from "./Avatar.js";

/**
 * Thẻ hồ sơ của **người khác** (bấm vào thành viên → Xem hồ sơ).
 *
 * Tự tải dữ liệu thay vì lấy từ danh sách thành viên: `GuildMemberSummary` chỉ
 * có tên/avatar, còn hồ sơ cần quyền riêng tư riêng (chung server / bạn / DM).
 * Server trả 404 khi không có liên hệ — hiện thông báo riêng tư chứ không phải
 * "không tìm thấy", vì hai chuyện khác nhau với người dùng.
 */
export function UserProfileCard({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "private" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setProfile(null);
    authedApi
      .getPublicProfile(userId)
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 404 là "không có liên hệ" **hoặc** tài khoản đã mất — server cố tình
        // không phân biệt (để không xác nhận id có thật), nên client cũng vậy.
        setStatus(error instanceof ApiError && error.status === 404 ? "private" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  // Tên hiển thị dưới avatar; chưa tải xong thì để trống (avatar hiện "?").
  const name = profile?.displayName ?? "";
  const color = bannerColorOf(profile);
  const joined =
    profile !== null
      ? new Date(profile.createdAt).toLocaleDateString(locale === "vi" ? "vi-VN" : "en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;

  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-label={t("profileCardTitle")}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
      >
        {/* Dải màu banner: cùng một màu người dùng chọn, chữ tự đổi trắng/đen. */}
        <div className="h-20" style={{ backgroundColor: color }} aria-hidden />

        <div className="px-5 pb-5">
          <div className="-mt-8 mb-2 flex items-end justify-between">
            <div className="rounded-full bg-slate-900 p-1">
              <Avatar
                avatarUrl={profile?.avatarUrl ?? null}
                name={name || "?"}
                size="size-16"
                textClass="text-xl"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
            >
              ✕
            </button>
          </div>

          {status === "loading" && (
            <p className="py-4 text-xs text-slate-400">{t("loading")}</p>
          )}

          {status === "private" && (
            <p className="rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-300">
              {t("profileCardPrivate")}
            </p>
          )}

          {status === "error" && (
            <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <p>{t("profileCardNotFound")}</p>
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                className="mt-1.5 rounded-md border border-rose-300/30 px-2 py-0.5 text-[11px] hover:bg-rose-400/10"
              >
                {t("profileCardRetry")}
              </button>
            </div>
          )}

          {profile !== null && (
            <>
              <p className="truncate text-base font-semibold text-slate-50">
                {profile.displayName}
              </p>
              <p className="truncate text-xs text-slate-500">
                @{profile.username}
                {profile.pronouns !== null && (
                  <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {profile.pronouns}
                  </span>
                )}
              </p>

              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                {t("profileAbout")}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-200">
                {profile.bio !== null ? profile.bio : (
                  <span className="text-slate-500">{t("profileEmptyAbout")}</span>
                )}
              </p>

              {joined !== null && (
                <p className="mt-3 text-[11px] text-slate-500">
                  {t("profileCardJoined", { date: joined })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
