import { useState } from "react";
import type { PollInput } from "@umaru/sdk";
import { useT } from "../lib/i18n.js";

/**
 * Hộp tạo bình chọn (modal nhỏ trong khung chat).
 *
 * Kiểm ở client chỉ để đỡ phải gửi request chắc chắn 400 — **server vẫn kiểm
 * lại toàn bộ** (2–10 lựa chọn, nhãn ≤ 55 ký tự, không trùng, thời lượng 1–168
 * giờ). Ở đây chặn hai thứ dễ gặp nhất: nút gửi khi chưa đủ hai lựa chọn có nội
 * dung, và nhãn trùng (người bỏ phiếu không biết mình chọn cái nào).
 */

const MAX_OPTIONS = 10;
const LABEL_MAX = 55;
const QUESTION_MAX = 300;
/** Lựa chọn thời hạn — giá trị `null` = không hết hạn. */
const DURATIONS: Array<number | null> = [null, 1, 4, 8, 24, 72, 168];

export function PollComposer({
  onClose,
  onSend,
  busy,
}: {
  onClose: () => void;
  onSend: (poll: PollInput) => void;
  busy: boolean;
}) {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [durationHours, setDurationHours] = useState<number | null>(null);

  const filled = options.map((option) => option.trim()).filter((option) => option.length > 0);
  const duplicates = new Set(filled).size !== filled.length;
  const canSend = question.trim().length > 0 && filled.length >= 2 && !duplicates && !busy;

  function submit(): void {
    if (!canSend) return;
    onSend({
      question: question.trim(),
      options: filled,
      allowMultiple,
      ...(durationHours === null ? {} : { durationHours }),
    });
  }

  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <form
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 className="mb-3 text-sm font-semibold">{t("pollCreate")}</h3>

        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {t("pollQuestion")}
        </label>
        <input
          autoFocus
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={QUESTION_MAX}
          className="mb-3 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
        />

        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {t("pollOptions")}
          </span>
          <button
            type="button"
            disabled={options.length >= MAX_OPTIONS}
            onClick={() => setOptions([...options, ""])}
            className="text-[11px] text-emerald-300 hover:text-emerald-200 disabled:opacity-50"
          >
            + {t("pollAddOption")}
          </button>
        </div>
        <div className="mb-2 flex flex-col gap-1.5">
          {options.map((option, index) => (
            <input
              key={index}
              value={option}
              onChange={(event) => {
                const next = [...options];
                next[index] = event.target.value;
                setOptions(next);
              }}
              maxLength={LABEL_MAX}
              placeholder={t("pollOption", { index: index + 1 })}
              aria-label={t("pollOption", { index: index + 1 })}
              className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-1.5 text-sm outline-none focus:border-emerald-400/60"
            />
          ))}
        </div>
        {duplicates && (
          <p role="alert" className="mb-2 text-[11px] text-rose-300">
            {t("pollDuplicate")}
          </p>
        )}

        <label className="mb-2 flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(event) => setAllowMultiple(event.target.checked)}
            className="size-3.5 accent-emerald-400"
          />
          {t("pollAllowMultiple")}
        </label>

        <label className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {t("pollDuration")}
          <select
            value={durationHours === null ? "none" : String(durationHours)}
            onChange={(event) =>
              setDurationHours(event.target.value === "none" ? null : Number(event.target.value))
            }
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-emerald-400/60"
          >
            {DURATIONS.map((hours) => (
              <option key={hours ?? "none"} value={hours ?? "none"}>
                {hours === null
                  ? t("pollDurationNone")
                  : t("pollDurationHours", { hours: String(hours) })}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          >
            {t("pollCancel")}
          </button>
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-60"
          >
            {busy ? t("loading") : t("pollSend")}
          </button>
        </div>
      </form>
    </div>
  );
}
