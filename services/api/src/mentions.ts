import type { Pool } from "./db.js";

/**
 * `@username` trong nội dung tin nhắn. Username chỉ chứa `a-z0-9._-`
 * (CHECK trong bảng users) nên cắt theo đúng bộ ký tự đó.
 */
const MENTION_PATTERN = /@([a-z0-9._-]{2,32})/gi;

/** Danh sách username (lowercase, không trùng) được @gọi trong nội dung. */
export function extractMentions(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const name = match[1]?.toLowerCase() ?? "";
    if (name.length >= 2) names.add(name);
  }
  return [...names];
}

/**
 * Ghi lại danh sách user được @mention cho một tin nhắn (xoá cũ → thêm mới).
 * Gọi sau khi tạo và sau khi sửa tin; tin bị xoá thì bảng tự CASCADE.
 * Username không tồn tại → bỏ qua, không lỗi (vẫn hiển thị nguyên văn).
 */
export async function syncMessageMentions(
  pool: Pool,
  messageId: string,
  channelId: string,
  content: string,
): Promise<void> {
  await pool.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);

  const names = extractMentions(content);
  if (names.length === 0) return;
  const users = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = ANY($1::text[])",
    [names],
  );
  if (users.rows.length === 0) return;

  const placeholders = users.rows.map((_, index) => `($1, $${index + 2}, $${users.rows.length + 2})`);
  await pool.query(
    `INSERT INTO message_mentions (message_id, user_id, channel_id)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT DO NOTHING`,
    [messageId, ...users.rows.map((row) => row.id), channelId],
  );
}
