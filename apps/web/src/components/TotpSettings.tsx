import type { SecurityStatus, TotpSetup } from "@umaru/sdk";
import { useEffect, useState } from "react";
import { authedApi } from "../lib/session.js";
import { useT } from "../lib/i18n.js";

/**
 * Bật/tắt xác thực hai lớp (TOTP) — khối trong hộp thoại hồ sơ.
 *
 * Trạng thái cục bộ ở đây thay vì `chatStore` vì đây là luồng một chiều, chỉ
 * sống trong lúc hộp thoại mở: thêm vào store toàn cục chỉ làm nặng thêm mà
 * không ai khác dùng.
 *
 * Hai điều cố ý:
 *  - Bí mật **không** tự ẩn sau nút "hiện": người dùng phải chép được nó, và nó
 *    chỉ sống trong lúc bật. Ẩn đi chỉ làm khó người không quét được QR.
 *  - Mã khôi phục hiện **một lần** kèm nút tải `.txt`; đóng là mất, đúng như
 *    cảnh báo trên màn hình.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "setup"; setup: TotpSetup }
  | { kind: "recovery"; codes: string[] };

export function TotpSettings() {
  const t = useT();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void authedApi.security().then(
      (next) => {
        if (alive) setStatus(next);
      },
      () => {
        // Không tải được trạng thái thì ẩn cả khối — thà thiếu mục còn hơn hiện
        // nút "Bật" trong khi tài khoản đã bật (người dùng sẽ tưởng bị lỗi).
        if (alive) setStatus(null);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  function apiMessage(failure: unknown): string {
    const body = (failure as { body?: { error?: { message?: string } } }).body;
    return body?.error?.message ?? (failure instanceof Error ? failure.message : String(failure));
  }

  function startSetup(): void {
    void run(async () => {
      try {
        const setup = await authedApi.setupTotp();
        setPhase({ kind: "setup", setup });
        setCode("");
      } catch (failure) {
        setError(apiMessage(failure));
      }
    });
  }

  function confirmSetup(): void {
    void run(async () => {
      try {
        const { recoveryCodes } = await authedApi.enableTotp(code);
        setStatus({ totpEnabled: true, recoveryCodesLeft: recoveryCodes.length });
        setPhase({ kind: "recovery", codes: recoveryCodes });
        setCode("");
      } catch (failure) {
        setError(apiMessage(failure));
      }
    });
  }

  function disable(): void {
    void run(async () => {
      try {
        await authedApi.disableTotp(password);
        setStatus({ totpEnabled: false, recoveryCodesLeft: 0 });
        setPassword("");
        setPhase({ kind: "idle" });
        setInfo(t("totpDisabled"));
      } catch (failure) {
        setError(apiMessage(failure));
      }
    });
  }

  function regenerate(): void {
    void run(async () => {
      try {
        const { recoveryCodes } = await authedApi.regenerateRecoveryCodes(password);
        setStatus((current) =>
          current === null ? current : { ...current, recoveryCodesLeft: recoveryCodes.length },
        );
        setPhase({ kind: "recovery", codes: recoveryCodes });
        setPassword("");
      } catch (failure) {
        setError(apiMessage(failure));
      }
    });
  }

  function downloadCodes(codes: string[]): void {
    const body = [
      "Umaru — mã khôi phục xác thực hai lớp",
      "Mỗi mã dùng được một lần. Giữ ở nơi an toàn, không chia sẻ.",
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "umaru-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (status === null) return null;

  return (
    <div className="mb-4 rounded-lg border border-white/10 p-2.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {t("securityTitle")}
      </p>
      <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-200">
        <span
          className={`size-2 rounded-full ${status.totpEnabled ? "bg-emerald-400" : "bg-slate-600"}`}
          aria-hidden
        />
        {status.totpEnabled ? t("totpOn") : t("totpOff")}
        {status.totpEnabled && (
          <span className="text-[11px] text-slate-500">
            · {t("totpCodesLeft", { count: String(status.recoveryCodesLeft) })}
          </span>
        )}
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

      {phase.kind === "setup" && (
        <div className="mb-2 space-y-2 rounded-md border border-white/10 bg-slate-950/40 p-2">
          <p className="text-[11px] text-slate-400">{t("totpHintSetup")}</p>
          <code className="block select-all break-all rounded bg-slate-900 px-2 py-1 text-xs tracking-wider text-emerald-200">
            {phase.setup.secretGroups}
          </code>
          <a
            href={phase.setup.otpauthUrl}
            className="block truncate text-[11px] text-sky-300 underline decoration-dotted"
          >
            {t("totpOpenInApp")}
          </a>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            placeholder={t("totpCode")}
            className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-sm tracking-[0.25em] outline-none focus:border-emerald-400/60"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || code.trim().length === 0}
              onClick={confirmSetup}
              className="rounded-md bg-emerald-400 px-2 py-1 text-[11px] font-semibold text-emerald-950 disabled:opacity-60"
            >
              {t("totpConfirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPhase({ kind: "idle" });
                setCode("");
              }}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "recovery" && (
        <div className="mb-2 space-y-2 rounded-md border border-amber-400/30 bg-amber-400/5 p-2">
          <p className="text-[11px] text-amber-200">{t("totpRecoveryOnce")}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-[11px] text-slate-100">
            {phase.codes.map((one) => (
              <li key={one} className="select-all">
                {one}
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => downloadCodes(phase.codes)}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-200"
            >
              {t("totpDownload")}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "idle" })}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400"
            >
              {t("totpSaved")}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "idle" && (
        <>
          {!status.totpEnabled && (
            <button
              type="button"
              disabled={busy}
              onClick={startSetup}
              className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-60"
            >
              {t("totpEnable")}
            </button>
          )}
          {status.totpEnabled && (
            <div className="space-y-1.5">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder={t("password")}
                className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs outline-none focus:border-emerald-400/60"
              />
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy || password.length === 0}
                  onClick={regenerate}
                  className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-60"
                >
                  {t("totpRegenerate")}
                </button>
                <button
                  type="button"
                  disabled={busy || password.length === 0}
                  onClick={disable}
                  className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 disabled:opacity-60"
                >
                  {t("totpDisable")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
