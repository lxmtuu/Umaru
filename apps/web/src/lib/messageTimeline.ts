import type { Message } from "@umaru/protocol";

/**
 * Dựng "timeline" của khung chat giống Discord: chèn vạch ngày và gộp tin nhắn
 * liên tiếp của cùng một người.
 *
 * Vì sao tách khỏi component: đây là logic thuần (thời gian + so sánh), test được
 * mà không cần render; và luật gộp rất dễ sai lệch (múi giờ, tin trả lời, tin bị
 * sửa) nên cần test khoá lại.
 */

export type TimelineItem =
  | { kind: "divider"; key: string; timestamp: number }
  | { kind: "message"; key: string; message: Message; grouped: boolean };

/** Gộp tin trong cùng "cụm" nếu cách nhau không quá 5 phút (như Discord). */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * @param messages Tin đã sắp **tăng dần theo thời gian** (thứ tự hiển thị).
 */
export function buildTimeline(messages: Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previous: Message | null = null;
  let currentDay: number | null = null;

  for (const message of messages) {
    const timestamp = new Date(message.createdAt).getTime();
    const day = startOfDay(timestamp);

    if (currentDay !== day) {
      items.push({ kind: "divider", key: `divider-${day}`, timestamp });
      currentDay = day;
      // Sang ngày mới thì không gộp với tin cuối của ngày hôm trước.
      previous = null;
    }

    // Tin trả lời luôn đứng riêng: nó có khung trích dẫn phía trên, gộp vào cụm
    // sẽ làm khung đó dính vào tin của người khác.
    const grouped =
      previous !== null &&
      message.replyToId === null &&
      previous.authorId === message.authorId &&
      timestamp - new Date(previous.createdAt).getTime() <= GROUP_WINDOW_MS;

    items.push({ kind: "message", key: `message-${message.id}`, message, grouped });
    previous = message;
  }

  return items;
}

/** Nhãn ngày hiển thị trên vạch: "Hôm nay", "Hôm qua", hoặc ngày đầy đủ. */
export function dividerLabel(
  timestamp: number,
  now: number,
  locale: string,
  labels: { today: string; yesterday: string },
): string {
  const day = startOfDay(timestamp);
  const today = startOfDay(now);
  if (day === today) return labels.today;
  if (day === today - 24 * 60 * 60 * 1000) return labels.yesterday;
  return new Date(timestamp).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
