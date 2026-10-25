import { REPORT_REASONS, type GuildMemberSummary, type ReportReason } from "@umaru/protocol";
import { useState } from "react";
import { translate, useT, type MessageKey } from "../lib/i18n.js";
import { Avatar } from "./Avatar.js";

/** Nhãn hiển thị cho từng lý do báo cáo (khoá i18n dựng từ mã lý do). */
const REASON_LABEL: Record<ReportReason, MessageKey> = {
  spam: "reasonSpam",
  harassment: "reasonHarassment",
  hate: "reasonHate",
  sexual_content: "reasonSexualContent",
  violence: "reasonViolence",
  self_harm: "reasonSelfHarm",
  impersonation: "reasonImpersonation",
  other: "reasonOther",
};

export function reasonLabel(reason: ReportReason): string {
  return translate(REASON_LABEL[reason]);
}

/**
 * Hộp thoại báo cáo — dùng cho cả "báo cáo tin" và "báo cáo người".
 *
 * Không tự đóng sau khi gửi: component cha đóng khi `reportSent` thành công
 * (store xoá `reportTarget`), nên ở đây chỉ cần disable nút khi đang gửi.
 */
export function ReportDialog({
  label,
  sending,
  onCancel,
  onSubmit,
}: {
  label: string;
  sending: boolean;
  onCancel: () => void;
  onSubmit: (input: { reason: ReportReason; details?: string }) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState("");

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-slate-950/70 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            reason,
            ...(details.trim().length > 0 ? { details: details.trim() } : {}),
          });
        }}
        className="w-full max-w-sm rounded-xl border border-white/10 bg-slate-900 p-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("reportTitle", { name: label })}
      >
        <h2 className="text-sm font-semibold text-slate-100">
          {t("reportTitle", { name: label })}
        </h2>

        <label className="mt-3 block text-[11px] uppercase tracking-wide text-slate-500">
          {t("reportReason")}
        </label>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as ReportReason)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-sm outline-none focus:border-emerald-400/60"
        >
          {REPORT_REASONS.map((value) => (
            <option key={value} value={value}>
              {reasonLabel(value)}
            </option>
          ))}
        </select>

        <label className="mt-3 block text-[11px] uppercase tracking-wide text-slate-500">
          {t("reportDetails")}
        </label>
        <textarea
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          rows={3}
          maxLength={1000}
          className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-sm outline-none focus:border-emerald-400/60"
        />

        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-slate-300 hover:bg-white/5"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={sending}
            className="rounded bg-rose-500 px-3 py-1 font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
          >
            {sending ? t("loading") : t("reportSubmit")}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Panel "Người đã chặn" — nơi duy nhất bỏ chặn được, nên luôn có lối vào ở
 * sidebar (nếu không, chặn xong là mất đường quay lại).
 */
export function BlocksPanel({
  blocks,
  loading,
  onUnblock,
}: {
  blocks: GuildMemberSummary[] | null;
  loading: boolean;
  onUnblock: (userId: string) => void;
}) {
  const t = useT();

  if (blocks === null || blocks.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-sm text-slate-500">
        {blocks === null && loading ? t("loading") : t("blockedEmpty")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2">
      {blocks.map((entry) => (
        <div key={entry.userId} className="flex items-center gap-3 px-4 py-2">
          <Avatar
            avatarUrl={entry.avatarUrl}
            name={entry.displayName}
            size="size-8"
            textClass="text-xs"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-100">{entry.displayName}</p>
            <p className="truncate text-[11px] text-slate-500">@{entry.username}</p>
          </div>
          <button
            onClick={() => onUnblock(entry.userId)}
            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"
          >
            {t("unblock")}
          </button>
        </div>
      ))}
    </div>
  );
}
