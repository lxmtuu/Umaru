/**
 * Logic thuần cho ô soạn tin: gợi ý `@mention` và chèn chữ tại con trỏ.
 *
 * Tách khỏi component để test được mọi trường hợp biên mà không cần jsdom: con
 * trỏ ở giữa câu, `@` dính sau chữ khác (email `a@b`), query có ký tự lạ,…
 *
 * Định dạng mention là **`@username` văn bản thường** — đúng thứ server đã đọc
 * (`services/api/src/mentions.ts`, pattern `@([a-z0-9._-]{2,32})`). Vì vậy chèn
 * xong không cần "id ẩn" nào: tin nhắn gửi đi vẫn là chữ người dùng thấy, sửa
 * tay vẫn hiểu, và không có chỗ nào lệch giữa client với server.
 */

/**
 * Ký tự được phép trong phần đang gõ sau `@`.
 *
 * Rộng hơn username (có thêm chữ Unicode) vì gợi ý còn liệt kê **role**, và tên
 * role hay có dấu tiếng Việt (`@Đội QA`). Vẫn **không** cho khoảng trắng: gặp
 * khoảng trắng là người dùng đã gõ xong từ cần nhắc, popup phải đóng.
 */
const MENTION_QUERY_CHARS = /^[\p{L}\p{N}._-]*$/u;

export interface MentionTrigger {
  /** Vị trí dấu `@` trong chuỗi. */
  start: number;
  /** Phần đã gõ sau `@` (có thể rỗng — vừa bấm `@`). */
  query: string;
}

/**
 * `@` nào đang được gõ, nếu có.
 *
 * Chỉ nhận khi `@` đứng đầu chuỗi hoặc sau khoảng trắng/xuống dòng: `a@b.com` là
 * email, không phải mention, và tự bật popup giữa lúc gõ email là trải nghiệm
 * rất khó chịu.
 */
export function activeMention(text: string, caret: number): MentionTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // Khoảng cách từ `@` tới con trỏ phải là chính username đang gõ dở.
  const query = before.slice(at + 1);
  // Query quá dài thì không còn là username nữa (trần username là 32).
  if (query.length > 32) return null;
  if (!MENTION_QUERY_CHARS.test(query)) return null;
  if (at > 0 && !/\s/.test(text[at - 1] ?? "")) return null;
  return { start: at, query };
}

/** Tối đa bao nhiêu gợi ý hiện cùng lúc — vừa mắt và đủ để chọn bằng phím. */
export const MAX_MENTION_SUGGESTIONS = 6;

export interface MentionCandidate {
  username: string;
  displayName: string;
}

/**
 * Lọc + sắp gợi ý.
 *
 * Ưu tiên: username khớp đầu → displayName khớp đầu → khớp giữa chuỗi. Giống
 * Discord: gõ `@an` phải thấy `an` trước `hoanganh`, chứ không phải theo thứ tự
 * bảng chữ cái của người vào server trước.
 */
export function rankMentionCandidates<T extends MentionCandidate>(
  candidates: T[],
  query: string,
  limit = MAX_MENTION_SUGGESTIONS,
): T[] {
  const needle = query.toLowerCase();
  const scored: Array<{ item: T; score: number; name: string }> = [];
  for (const item of candidates) {
    const username = item.username.toLowerCase();
    const display = item.displayName.toLowerCase();
    let score: number;
    if (needle.length === 0) score = 3;
    else if (username.startsWith(needle)) score = 0;
    else if (display.startsWith(needle)) score = 1;
    else if (username.includes(needle) || display.includes(needle)) score = 2;
    else continue;
    scored.push({ item, score, name: username });
  }
  scored.sort((a, b) =>
    a.score === b.score
      ? a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0
      : a.score - b.score,
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}

/** Thay đoạn `[start, end)` bằng `snippet`, trả về chuỗi mới và vị trí con trỏ. */
export function insertSnippet(
  text: string,
  start: number,
  end: number,
  snippet: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return {
    text: `${text.slice(0, from)}${snippet}${text.slice(to)}`,
    caret: from + snippet.length,
  };
}

/**
 * Thay `@query` đang gõ bằng `@username` + dấu cách.
 *
 * Dấu cách ở cuối là chủ ý: viết tiếp ngay sau mention mà không có khoảng trắng
 * thì regex phía server sẽ đọc liền thành một username khác và **không** báo ai.
 */
export function applyMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  username: string,
): { text: string; caret: number } {
  return insertSnippet(text, trigger.start, caret, `@${username} `);
}
