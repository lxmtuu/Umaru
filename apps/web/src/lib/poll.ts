import type { Poll } from "@umaru/protocol";

/**
 * Logic thuần của bình chọn: tính phần trăm và tính **tập phiếu mới** khi bấm
 * một lựa chọn.
 *
 * Tách khỏi component vì đây là chỗ dễ sai mà không ai thấy: poll "chọn một" mà
 * gửi thêm id là server trả 400, còn bấm lại đúng lựa chọn đang chọn thì phải
 * **rút phiếu** chứ không phải gửi lại (gửi lại là không có cách nào bỏ phiếu).
 */

/** Phần trăm làm tròn xuống; `totalVotes === 0` thì 0% (không chia cho 0). */
export function pollPercent(votes: number, totalVotes: number): number {
  if (totalVotes <= 0 || votes <= 0) return 0;
  return Math.min(100, Math.floor((votes * 100) / totalVotes));
}

/**
 * Tập lựa chọn mới sau khi người dùng bấm `optionId`.
 *
 * - Chọn một: bấm lựa chọn đang chọn ⇒ `[]` (rút phiếu); bấm lựa chọn khác ⇒
 *   `[optionId]` (server tự xoá phiếu cũ, nhưng gửi đúng ý định vẫn rõ hơn).
 * - Chọn nhiều: bật/tắt đúng lựa chọn đó, giữ nguyên các lựa chọn khác.
 *
 * Poll đã kết thúc thì **không đổi gì** — trả lại nguyên trạng để UI không gửi
 * một request chắc chắn 400.
 */
export function nextVoteSelection(poll: Poll, optionId: string): string[] {
  const current = poll.options.filter((option) => option.me).map((option) => option.id as string);
  if (poll.ended) return current;
  if (current.includes(optionId)) {
    return poll.allowMultiple ? current.filter((id) => id !== optionId) : [];
  }
  return poll.allowMultiple ? [...current, optionId] : [optionId];
}

/** Câu mô tả thời hạn còn lại — dùng chung cho khung poll (không cần i18n số phức). */
export function pollTimeLeft(
  poll: Poll,
  now = Date.now(),
): { kind: "ended" } | { kind: "none" } | { kind: "left"; minutes: number } {
  if (poll.expiresAt === null) return poll.ended ? { kind: "ended" } : { kind: "none" };
  if (poll.ended) return { kind: "ended" };
  const remaining = new Date(poll.expiresAt).getTime() - now;
  if (remaining <= 0) return { kind: "ended" };
  return { kind: "left", minutes: Math.max(1, Math.ceil(remaining / 60_000)) };
}
