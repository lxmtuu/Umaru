import { useEffect, useState } from "react";
import type { OAuthAccountsResult, OAuthProviderId } from "@umaru/sdk";
import { authedApi } from "../lib/session.js";
import { useT } from "../lib/i18n.js";

/**
 * Tài khoản liên kết (Google/GitHub) + đặt mật khẩu.
 *
 * Hai thứ đi cùng nhau có lý do: tài khoản tạo bằng OAuth có `password_hash =
 * NULL`, và server **chặn** gỡ provider cuối cùng của tài khoản không mật khẩu
 * (nếu không, người dùng tự khoá mình ra ngoài). Nên muốn gỡ thì phải đặt mật
 * khẩu trước — hai nút nằm cạnh nhau để thấy ngay mối liên hệ đó.
 *
 * Trạng thái cục bộ, không đưa vào `chatStore`: chỉ sống trong lúc hộp thoại mở.
 */
export function LinkedAccountsSettings() {
  const t = useT();
  const [data, setData] = useState<OAuthAccountsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");

  useEffect(() => {
    let alive = true;
    void authedApi.oauthAccounts().then(
      (next) => {
        if (alive) setData(next);
      },
      () => {
        if (alive) setData(null);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  function apiMessage(failure: unknown): string {
    const body = (failure as { body?: { error?: { message?: string } } }).body;
    return body?.error?.message ?? (failure instanceof Error ? failure.message : String(failure));
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
    } catch (failure) {
      setError(apiMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function unlink(provider: OAuthProviderId): void {
    void run(async () => {
      await authedApi.unlinkOAuth(provider);
      // Tải lại từ server thay vì tự xoá khỏi mảng: `hasPassword` có thể đã đổi.
      setData(await authedApi.oauthAccounts());
      setInfo(t("accountsUnlinked"));
    });
  }

  function savePassword(): void {
    void run(async () => {
      await authedApi.setPassword(
        newPassword,
        data?.hasPassword === true ? currentPassword : undefined,
      );
      setData(await authedApi.oauthAccounts());
      setNewPassword("");
      setCurrentPassword("");
      setShowPassword(false);
      setInfo(t("accountsPasswordSaved"));
    });
  }

  if (data === null) return null;

  // Chưa cấu hình provider nào và tài khoản đã có mật khẩu: không có gì để nói.
  if (data.accounts.length === 0 && data.hasPassword) return null;

  return (
    <div className="mb-4 rounded-lg border border-white/10 p-2.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {t("accountsTitle")}
      </p>

      {error !== null && (
        <p role="alert" className="mb-2 rounded-md bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </p>
      )}
      {info !== null && (
        <p className="mb-2 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">
          {info}
        </p>
      )}

      {data.accounts.length === 0 ? (
        <p className="text-xs text-slate-400">{t("accountsNone")}</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {data.accounts.map((account) => (
            <li key={account.provider} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-200">{account.label}</span>
              <button
                type="button"
                disabled={busy || (data.accounts.length === 1 && !data.hasPassword)}
                title={
                  data.accounts.length === 1 && !data.hasPassword
                    ? t("accountsNeedPassword")
                    : undefined
                }
                onClick={() => unlink(account.provider)}
                className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/10 disabled:opacity-50"
              >
                {t("accountsUnlink")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mb-1.5 text-[11px] text-slate-500">
        {data.hasPassword ? t("accountsHasPassword") : t("accountsNoPassword")}
      </p>

      {!showPassword ? (
        <button
          type="button"
          onClick={() => setShowPassword(true)}
          className="rounded-md bg-white/10 px-2 py-1 text-[11px] text-slate-100 hover:bg-white/15"
        >
          {data.hasPassword ? t("accountsChangePassword") : t("accountsSetPassword")}
        </button>
      ) : (
        <div className="space-y-1.5">
          {data.hasPassword && (
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              placeholder={t("accountsCurrentPassword")}
              className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-sm outline-none focus:border-emerald-400/60"
            />
          )}
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            placeholder={t("accountsNewPassword")}
            className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-sm outline-none focus:border-emerald-400/60"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              // Máy chủ kiểm độ dài thật; đây chỉ chặn bấm nhầm.
              disabled={
                busy ||
                newPassword.length < 8 ||
                (data.hasPassword && currentPassword.length === 0)
              }
              onClick={savePassword}
              className="rounded-md bg-emerald-400 px-2 py-1 text-[11px] font-semibold text-emerald-950 disabled:opacity-60"
            >
              {t("save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPassword(false);
                setNewPassword("");
                setCurrentPassword("");
                setError(null);
              }}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
