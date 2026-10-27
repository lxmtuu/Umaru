import { useEffect, useState } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import {
  BANNER_COLORS,
  MAX_BIO_LENGTH,
  MAX_PRONOUNS_LENGTH,
  buildProfilePatch,
  characterCount,
  draftFromUser,
  isPatchEmpty,
  sameDraft,
  type ProfileDraft,
} from "../lib/profileForm.js";

/**
 * Khối sửa hồ sơ trong hộp thoại cá nhân: giới thiệu, đại từ, màu banner.
 *
 * Khác các khối còn lại của `ProfileDialog` (bấm là gửi ngay), khối này có nút
 * **Lưu**: sửa giới thiệu là soạn văn bản, gửi từng ký tự lên server thì vừa
 * tốn request vừa phát `USER_UPDATE` cho cả server mỗi lần gõ.
 *
 * Form giữ bản nháp riêng, chỉ gửi trường **đã đổi** — hai tab mở cùng lúc sửa
 * hai trường khác nhau sẽ không ghi đè lẫn nhau.
 */
export function ProfileFields({ onSaved }: { onSaved?: () => void } = {}) {
  const t = useT();
  const me = useChat((state) => state.me);
  const saving = useChat((state) => state.profileSaving);
  const error = useChat((state) => state.profileError);
  const saveProfile = useChat((state) => state.saveProfile);
  const clearProfileError = useChat((state) => state.clearProfileError);

  // `base` là bản đang có trên server, `draft` là bản người dùng đang sửa.
  // Giữ cả hai để biết "đã sửa hay chưa" khi server đổi từ bên ngoài.
  const [form, setForm] = useState<{ draft: ProfileDraft; base: ProfileDraft }>(() => {
    const initial = draftFromUser(me);
    return { draft: initial, base: initial };
  });
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Đồng bộ khi hồ sơ phía server đổi (tab khác lưu, hoặc `USER_UPDATE`).
   *
   * Người dùng **chưa sửa gì** → nhận giá trị mới. Đang sửa dở → giữ bản nháp,
   * chỉ nâng `base` lên, để patch gửi đi vẫn chỉ chứa đúng phần họ tự sửa.
   */
  const serverDraft = draftFromUser(me);
  useEffect(() => {
    setForm((current) => {
      if (sameDraft(current.base, serverDraft)) return current;
      const edited = !sameDraft(current.draft, current.base);
      return { draft: edited ? current.draft : serverDraft, base: serverDraft };
    });
  }, [serverDraft.bio, serverDraft.pronouns, serverDraft.bannerColor]);

  const { draft, base: original } = form;
  const patch = buildProfilePatch(draft, original);
  const dirty = !isPatchEmpty(patch);
  const bioCount = characterCount(draft.bio);
  const pronounsCount = characterCount(draft.pronouns);

  const update = (change: Partial<ProfileDraft>): void => {
    clearProfileError();
    setNotice(null);
    setForm((current) => ({ ...current, draft: { ...current.draft, ...change } }));
  };

  const handleSave = async (): Promise<void> => {
    if (!dirty || saving) return;
    const ok = await saveProfile(patch);
    if (ok) {
      setNotice(t("profileSaved"));
      // Nâng `base` ngay để nút Lưu tắt, không phải chờ `USER_UPDATE` về.
      setForm((current) => {
        const saved: ProfileDraft = {
          bio: current.draft.bio.trim(),
          pronouns: current.draft.pronouns.trim(),
          bannerColor: current.draft.bannerColor.trim().toLowerCase(),
        };
        return { draft: saved, base: saved };
      });
      onSaved?.();
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-white/10 p-2.5">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {t("profileAbout")}
      </p>

      <label className="block text-[11px] text-slate-400" htmlFor="profile-bio">
        {t("profileAbout")}
      </label>
      <textarea
        id="profile-bio"
        value={draft.bio}
        maxLength={MAX_BIO_LENGTH}
        rows={3}
        placeholder={t("profileAboutPlaceholder")}
        onChange={(event) => update({ bio: event.target.value })}
        className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-emerald-400/60"
      />
      <p className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
        <span>{t("profileAboutHint", { max: MAX_BIO_LENGTH })}</span>
        <span
          className={bioCount > MAX_BIO_LENGTH ? "text-rose-300" : undefined}
          aria-live="polite"
        >
          {bioCount}/{MAX_BIO_LENGTH}
        </span>
      </p>

      <label className="mt-2 block text-[11px] text-slate-400" htmlFor="profile-pronouns">
        {t("profilePronouns")}
      </label>
      <input
        id="profile-pronouns"
        type="text"
        value={draft.pronouns}
        maxLength={MAX_PRONOUNS_LENGTH}
        placeholder={t("profilePronounsPlaceholder")}
        onChange={(event) => update({ pronouns: event.target.value })}
        className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-emerald-400/60"
      />
      <p className="mt-0.5 text-right text-[11px] text-slate-500">
        {pronounsCount}/{MAX_PRONOUNS_LENGTH}
      </p>

      <p className="mt-2 text-[11px] text-slate-400">{t("profileBanner")}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {BANNER_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={draft.bannerColor.toLowerCase() === color}
            onClick={() => update({ bannerColor: color })}
            style={{ backgroundColor: color }}
            className={`size-6 rounded-full ring-offset-2 ring-offset-slate-900 ${
              draft.bannerColor.toLowerCase() === color ? "ring-2 ring-white" : "ring-1 ring-white/20"
            }`}
          />
        ))}
        <button
          type="button"
          aria-pressed={draft.bannerColor === ""}
          onClick={() => update({ bannerColor: "" })}
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            draft.bannerColor === ""
              ? "border-white/60 text-slate-100"
              : "border-white/10 text-slate-400 hover:text-slate-200"
          }`}
        >
          {t("profileBannerClear")}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t("profileBannerHint")}</p>

      {error !== null && (
        <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">{error}</p>
      )}
      {notice !== null && error === null && (
        <p role="status" className="mt-2 text-[11px] text-emerald-300">
          {notice}
        </p>
      )}

      <button
        type="button"
        disabled={!dirty || saving}
        onClick={() => void handleSave()}
        className="mt-2 w-full rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
      >
        {saving ? t("profileSaving") : t("profileSave")}
      </button>
    </div>
  );
}
