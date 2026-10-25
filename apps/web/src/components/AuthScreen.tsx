import { useState, type FormEvent } from "react";
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

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  /** Bắt buộc tick khi đăng ký — bằng chứng đồng ý điều khoản (server kiểm lại). */
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "login") {
      await login(email, password);
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

          {mode === "register" && (
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

          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {mode === "login" ? t("switchToRegister") : t("switchToLogin")}
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
