/**
 * Nháp tin **theo từng kênh**, lưu ở `localStorage`.
 *
 * Vì sao cần: đang gõ dở một đoạn dài rồi bấm sang kênh khác xem tin (hoặc F5 vì
 * deploy) là mất trắng. Discord giữ nháp từng kênh, và nó là thứ người dùng chỉ
 * nhận ra khi thiếu.
 *
 * Bốn quyết định:
 *
 *  1. **Khoá theo `userId`**: cùng một trình duyệt có thể đăng nhập nhiều tài
 *     khoản. Dùng chung một khoá thì nháp của người trước hiện ra cho người sau —
 *     rò rỉ nội dung riêng tư, không chỉ là "hiển thị sai".
 *  2. **Chỉ lưu chữ.** Tệp đính kèm không serialize được, còn khôi phục "đang trả
 *     lời tin X" sau vài ngày là bẫy: tin gốc có thể đã bị xoá.
 *  3. **Trần 2 000 ký tự** (đúng giới hạn server) và **tối đa 40 kênh**: nháp
 *     không được phép phình `localStorage` (5MB, dùng chung với token/âm thanh) và
 *     kênh cũ nhất bị đẩy ra thay vì làm hỏng cả kho.
 *  4. **Hỏng thì bỏ, không ném lỗi.** JSON rác (người dùng sửa tay, phiên bản cũ)
 *     phải quay về "không có nháp" — mất nháp còn hơn trắng màn hình chat.
 */

export const DRAFTS_KEY_PREFIX = "umaru.drafts.v1";
export const MAX_DRAFT_LENGTH = 2000;
export const MAX_DRAFT_CHANNELS = 40;

/** Tối thiểu của `localStorage` để test được mà không cần trình duyệt. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredDraft {
  text: string;
  at: number;
}

/** Khoá riêng cho từng tài khoản (xem quyết định 1). */
export function draftsKey(userId: string): string {
  return `${DRAFTS_KEY_PREFIX}:${userId}`;
}

function parse(raw: string | null): Record<string, StoredDraft> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const drafts: Record<string, StoredDraft> = {};
  for (const [channelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) continue;
    drafts[channelId] = {
      text: entry.text.slice(0, MAX_DRAFT_LENGTH),
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
    };
  }
  return drafts;
}

/** Bản trong bộ nhớ: `channelId → chữ chưa gửi`. */
export function readDrafts(storage: DraftStorage, userId: string): Record<string, string> {
  const stored = parse(storage.getItem(draftsKey(userId)));
  return Object.fromEntries(Object.entries(stored).map(([channelId, draft]) => [channelId, draft.text]));
}

/**
 * Ghi (hoặc xoá khi rỗng) nháp của một kênh, trả về bản đồ mới để đưa vào state.
 *
 * `now` để test được thứ tự đẩy kênh cũ ra; production dùng `Date.now()`.
 */
export function writeDraft(
  storage: DraftStorage,
  userId: string,
  channelId: string,
  text: string,
  now = Date.now(),
): Record<string, string> {
  const stored = parse(storage.getItem(draftsKey(userId)));
  const trimmed = text.slice(0, MAX_DRAFT_LENGTH);
  if (trimmed.trim().length === 0) delete stored[channelId];
  else stored[channelId] = { text: trimmed, at: now };

  const entries = Object.entries(stored).sort((a, b) => b[1].at - a[1].at);
  const kept = Object.fromEntries(entries.slice(0, MAX_DRAFT_CHANNELS));

  try {
    if (Object.keys(kept).length === 0) storage.removeItem(draftsKey(userId));
    else storage.setItem(draftsKey(userId), JSON.stringify(kept));
  } catch {
    // `localStorage` đầy hoặc bị chặn (chế độ riêng tư của một số trình duyệt):
    // nháp là tiện ích, không được làm hỏng việc gửi tin.
  }
  return Object.fromEntries(
    Object.entries(kept)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, draft]) => [id, draft.text]),
  );
}

/** Xoá sạch nháp của một tài khoản (đăng xuất — xem quyết định 1). */
export function clearDrafts(storage: DraftStorage, userId: string): void {
  try {
    storage.removeItem(draftsKey(userId));
  } catch {
    /* bị chặn thì thôi */
  }
}
