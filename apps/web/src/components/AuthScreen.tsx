import { useEffect, useState, type FormEvent } from "react";
import { useChat } from "../lib/chatStore.js";
import { useLocale, useT } from "../lib/i18n.js";
import { legalPath } from "../lib/legalRoute.js";

type Mode = "login" | "register";

export function AuthScreen() {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const login = useChat((state) => state.login);
  const register = useChat((state) => state.register);
  const busy = useChat((state) => state.busy);
  const error = useChat((state) => state.error);
  /** Mật khẩu đúng nhưng tài khoản có 2FA — form chuyển sang bước nhập mã. */
  const totpRequired = useChat((state) => state.totpRequired);
  const oauthProviders = useChat((state) => state.oauthProviders);
  const oauthPendingCode = useChat((state) => state.oauthPendingCode);
  const loadOAuthProviders = useChat((state) => state.loadOAuthProviders);
  const startOAuth = useChat((state) => state.startOAuth);
  const exchangeOAuthCode = useChat((state) => state.exchangeOAuthCode);

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  /** Bắt buộc tick khi đăng ký — bằng chứng đồng ý điều khoản (server kiểm lại). */
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  /** Bước nhập 2FA đến từ OAuth (không có email/mật khẩu trong form). */
  const oauthTotp = totpRequired && oauthPendingCode !== null;

  // Hỏi server provider nào đang bật (thiếu id/secret thì server không trả về).
  useEffect(() => {
    void loadOAuthProviders();
  }, [loadOAuthProviders]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Đến từ OAuth mà tài khoản có 2FA: mã đăng nhập đang chờ, chỉ thiếu mã 6 số.
    if (totpRequired && oauthPendingCode !== null) {
      await exchangeOAuthCode(oauthPendingCode, totpCode);
      return;
    }
    if (mode === "login") {
      await login(email, password, totpRequired ? totpCode : undefined);
    } else {
      if (!acceptedTerms) return;
      await register({
        username,
        displayName: displayName || username,
        email,
        password,
        acceptedTerms: true,
      });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="size-9 rounded-xl bg-emerald-400 shadow-lg shadow-emerald-400/30" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">{t("appName")}</h1>
              <p className="text-xs text-slate-400">{t("tagline")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLocale(locale === "en" ? "vi" : "en")}
            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10"
            aria-label={t("language")}
          >
            {locale === "en" ? "EN" : "VI"}
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl shadow-black/40"
        >
          <h2 className="text-lg font-semibold">{mode === "login" ? t("login") : t("register")}</h2>

          {mode === "register" && !oauthTotp && (
            <>
              <Field label={t("username")}>
                <input
                  name="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  minLength={2}
                  maxLength={32}
                  autoComplete="username"
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
                />
              </Field>
              <Field label={t("displayName")}>
                <input
                  name="displayName"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={32}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
                />
              </Field>
            </>
          )}

          {/* Vào bằng OAuth rồi gặp 2FA: không có email/mật khẩu để hiện, và
              input `required` sẽ chặn luôn nút gửi. */}
          {!oauthTotp && (
            <>
              <Field label={t("email")}>
                <input
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
                />
              </Field>

              <Field label={t("password")}>
                <input
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === "register" ? 8 : 1}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
                />
              </Field>
            </>
          )}

          {totpRequired && (
            <Field label={t("totpCode")}>
              <input
                name="totpCode"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                // `one-time-code` để iOS/Android gợi ý mã vừa nhận; `numeric` để
                // điện thoại hiện bàn phím số.
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9 ]*"
                maxLength={12}
                autoFocus
                required
                className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm tracking-[0.3em] outline-none focus:border-emerald-400/60"
              />
              <span className="text-[11px] text-slate-500">
                {oauthTotp ? t("oauthPendingHint") : t("totpCodeHint")}
              </span>
            </Field>
          )}

          {mode === "register" && (
            <label className="flex items-start gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                name="acceptedTerms"
                checked={acceptedTerms}
                onChange={(event) => setAcceptedTerms(event.target.checked)}
                required
                className="mt-0.5 size-3.5 accent-emerald-400"
              />
              <span>
                {t("legalConsent")}{" "}
                <a
                  href={legalPath("terms", locale)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 underline decoration-dotted hover:text-emerald-200"
                >
                  {t("termsShort")}
                </a>{" "}
                {t("legalConsentAnd")}{" "}
                <a
                  href={legalPath("privacy", locale)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 underline decoration-dotted hover:text-emerald-200"
                >
                  {t("privacyShort")}
                </a>
                .
              </span>
            </label>
          )}

          {error !== null && (
            <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || (mode === "register" && !acceptedTerms)}
            className="mt-1 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-60"
          >
            {busy ? t("loading") : mode === "login" ? t("loginAction") : t("registerAction")}
          </button>

          {oauthProviders.length > 0 && !totpRequired && (
            <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500">
                <span className="h-px flex-1 bg-white/10" />
                {t("oauthOr")}
                <span className="h-px flex-1 bg-white/10" />
              </div>
              {oauthProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  // Đăng ký bằng OAuth vẫn phải tick điều khoản: server giữ cờ
                  // `acceptedTerms` qua redirect và kiểm lại trước khi tạo user.
                  disabled={busy || (mode === "register" && !acceptedTerms)}
                  onClick={() => void startOAuth(provider.id, acceptedTerms)}
                  className="rounded-lg border border-white/10 bg-slate-900/70 px-4 py-2 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-60"
                >
                  {t("oauthContinueWith", { provider: provider.label })}
                </button>
              ))}
              {mode === "register" && !acceptedTerms && (
                <p className="text-[11px] text-slate-500">
                  {t("oauthTermsBefore", { provider: oauthProviders[0]?.label ?? "OAuth" })}
                </p>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              if (totpRequired) {
                // Quay lại bước mật khẩu (gõ nhầm tài khoản) — xoá mã đang gõ.
                // Với OAuth, mã đăng nhập đang chờ cũng bỏ: người dùng muốn đăng
                // nhập bằng cách khác, và mã đó chỉ sống 2 phút.
                setTotpCode("");
                useChat.setState({
                  totpRequired: false,
                  oauthPendingCode: null,
                  error: null,
                });
                return;
              }
              setMode(mode === "login" ? "register" : "login");
            }}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {totpRequired ? t("totpBack") : mode === "login" ? t("switchToRegister") : t("switchToLogin")}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</span>
      {children}
    </label>
  );
}
