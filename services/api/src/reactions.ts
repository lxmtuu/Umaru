import type { ReactionSummary } from "@umaru/protocol";
import type { Pool } from "./db.js";
import { badRequest } from "./http.js";

/**
 * Reaction emoji trên tin nhắn.
 *
 * Hai quyết định đáng ghi lại:
 *
 * 1. **Gộp ở SQL, không gộp ở client.** `count(*)` + `bool_or(user_id = $viewer)`
 *    cho ra đúng thứ client cần (`emoji`, `count`, `me`) trong một câu SQL cho cả
 *    trang tin — không có chuyện một trang 50 tin sinh 50 câu, và `me` luôn tính
 *    theo người xem hiện tại.
 * 2. **Trần số emoji khác nhau trên một tin.** Không có trần thì một người có thể
 *    thả 500 emoji khác nhau vào một tin, làm mọi client phải render 500 chip và
 *    phình payload của cả trang. Trần đặt ở mức đủ dùng (20) và trả 400 rõ ràng.
 */

/** Số emoji **khác nhau** tối đa trên một tin (mỗi người vẫn thả được nhiều). */
export const MAX_REACTIONS_PER_MESSAGE = 20;

/** Trần độ dài một emoji — đủ cho emoji gia đình + skin tone. */
export const MAX_EMOJI_LENGTH = 32;

interface ReactionRow {
  message_id: string;
  emoji: string;
  total: string | number;
  me: boolean;
}

/**
 * Kiểm emoji client gửi lên.
 *
 * Không cố "đoán đây có phải emoji không" (Unicode rất rộng, đoán sai là chặn
 * emoji hợp lệ). Chỉ chặn thứ chắc chắn sai: rỗng, có khoảng trắng/xuống dòng
 * (một reaction không phải một đoạn văn), có ký tự điều khiển, hoặc quá dài.
 */
export function normalizeEmoji(raw: string): string {
  const emoji = raw.trim();
  if (emoji.length === 0) throw badRequest("Thiếu emoji");
  if (/[\s\u0000-\u001f\u007f]/.test(emoji)) {
    throw badRequest("Emoji không được chứa khoảng trắng hay ký tự điều khiển");
  }
  // Đếm theo codepoint để không cắt đôi surrogate pair.
  if ([...emoji].length > MAX_EMOJI_LENGTH) {
    throw badRequest(`Emoji tối đa ${MAX_EMOJI_LENGTH} ký tự`);
  }
  return emoji;
}

/** Reaction của nhiều tin, gộp theo emoji, `me` tính theo `viewerId`. */
export async function loadReactionsByMessage(
  pool: Pool,
  messageIds: string[],
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const byMessage = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return byMessage;

  const result = await pool.query<ReactionRow>(
    `SELECT message_id,
            emoji,
            count(*)::int AS total,
            bool_or(user_id = $2::bigint) AS me
       FROM message_reactions
      WHERE message_id = ANY($1::bigint[])
      GROUP BY message_id, emoji
      ORDER BY min(created_at), emoji`,
    [messageIds, viewerId],
  );
  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, count: Number(row.total), me: row.me });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

/** Reaction của một tin (dùng cho response sau khi thả/bỏ, và cho event). */
export async function reactionsForMessage(
  pool: Pool,
  messageId: string,
  viewerId: string,
): Promise<ReactionSummary[]> {
  const map = await loadReactionsByMessage(pool, [messageId], viewerId);
  return map.get(messageId) ?? [];
}

/** Số emoji **khác nhau** đang có trên một tin. */
export async function countDistinctReactions(pool: Pool, messageId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    "SELECT count(DISTINCT emoji)::text AS total FROM message_reactions WHERE message_id = $1",
    [messageId],
  );
  return Number(result.rows[0]?.total ?? "0");
}
