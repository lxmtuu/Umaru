import type { Message, Poll } from "@umaru/protocol";
import { nextVoteSelection, pollPercent, pollTimeLeft } from "../lib/poll.js";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";

/**
 * Khung bình chọn trong một tin nhắn.
 *
 * Hai điều cố ý:
 *  - **Không tự sửa state sau khi bấm**: server là nguồn sự thật (nó phát
 *    `MESSAGE_UPDATE` cho cả kênh, và trả message đã cập nhật cho người bấm), nên
 *    cộng/trừ tại chỗ sẽ lệch ngay khi hai người bấm cùng lúc.
 *  - **Kết quả hiện trước khi bỏ phiếu** (giống Discord): giấu kết quả tới khi
 *    bỏ phiếu nghe thì "công bằng" nhưng làm poll vô dụng — người ta bỏ phiếu để
 *    xem kết quả, và đa số bỏ phiếu sau khi đã thấy xu hướng.
 */
export function PollCard({ message, poll }: { message: Message; poll: Poll }) {
  const t = useT();
  const votePoll = useChat((state) => state.votePoll);
  const busy = useChat((state) => state.pollBusy === message.id);
  const timeLeft = pollTimeLeft(poll);

  function vote(optionId: string): void {
    const selection = nextVoteSelection(poll, optionId);
    // Đã chọn và bấm lại (chọn một) ⇒ gửi mảng rỗng = rút phiếu.
    void votePoll(message.id as string, selection);
  }

  return (
    <div
      className="mt-1 w-full max-w-md rounded-lg border border-white/10 bg-slate-900/50 p-2.5"
      data-testid="poll"
    >
      <p className="mb-2 text-sm font-semibold text-slate-100">{poll.question}</p>

      <ul className="flex flex-col gap-1.5">
        {poll.options.map((option) => {
          const percent = pollPercent(option.votes, poll.totalVotes);
          return (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => vote(option.id as string)}
                disabled={poll.ended || busy}
                aria-pressed={option.me}
                className={`relative w-full overflow-hidden rounded-md border px-2 py-1.5 text-left text-xs transition disabled:cursor-default ${
                  option.me
                    ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-100"
                    : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                }`}
              >
                {/* Thanh kết quả nằm **dưới** chữ, không phải cạnh chữ: chiều rộng
                    cố định làm nhãn dài bị đẩy sang, đọc không nổi. */}
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-emerald-400/15"
                  style={{ width: `${percent}%` }}
                />
                <span className="relative flex items-center justify-between gap-2">
                  <span className="truncate">
                    {option.me ? "✓ " : ""}
                    {option.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-300">
                    {option.votes} · {percent}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>{t("pollVotes", { count: String(poll.totalVotes) })}</span>
        <span>
          {timeLeft.kind === "ended"
            ? t("pollEnded")
            : timeLeft.kind === "none"
              ? t("pollNoDeadline")
              : t("pollTimeLeft", { minutes: String(timeLeft.minutes) })}
          {poll.allowMultiple ? ` · ${t("pollMultiple")}` : ""}
        </span>
      </p>
    </div>
  );
}
