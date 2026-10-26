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

/** Chuỗi cần tìm cho một role: `@Tên`, tránh nhân đôi `@` của `@everyone`. */
export function mentionNeedle(roleName: string): string {
  const trimmed = roleName.trim();
  return trimmed.startsWith("@") ? trimmed.toLowerCase() : `@${trimmed.toLowerCase()}`;
}

/** Trần số người được ghi nhận cho **một** tin khi nhắc theo role. */
export const MAX_ROLE_MENTION_RECIPIENTS = 1_000;

export interface MentionRole {
  id: string;
  name: string;
  isEveryone: boolean;
}

/**
 * Role nào được `@nhắc` trong nội dung.
 *
 * Vì sao nhắc role bằng **tên** chứ không phải `<@&id>`: giữ đúng triết lý của
 * dự án — nội dung tin là thứ người dùng thấy, không có "id ẩn" nào (xem
 * `apps/web/src/lib/composer.ts`). Đánh đổi đã biết: **đổi tên role thì tin cũ
 * vẫn ping đúng người** (dòng mention đã ghi lúc gửi) nhưng tin **mới** gõ theo
 * tên cũ sẽ không ping nữa; hai role trùng tên thì ping cả hai. Discord dùng
 * `<@&id>` nên không dính các đánh đổi này — nếu sau này cần, đây là chỗ đổi.
 *
 * Thứ tự khớp: **tên dài trước** để `@Đội ngũ QA` không bị ăn bởi role `@QA`.
 */
export function extractRoleMentions(content: string, roles: MentionRole[]): MentionRole[] {
  const haystack = content.toLowerCase();
  const ordered = [...roles]
    .filter((role) => role.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const hits: MentionRole[] = [];
  for (const role of ordered) {
    // `@everyone` có sẵn dấu `@` trong tên role; ghép thêm `@` nữa sẽ thành
    // `@@everyone` — lỗi im lặng đúng kiểu "không ai nhận được thông báo".
    const needle = mentionNeedle(role.name);
    let from = 0;
    while (true) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      // `@` phải đứng đầu câu hoặc sau khoảng trắng — `a@Role` là email/danh từ
      // dính chữ, không phải nhắc.
      const before = at === 0 ? " " : (haystack[at - 1] ?? " ");
      if (!/\s/.test(before)) continue;
      // Không cắt giữa từ: `@Moderator` không khớp role `@Mod`.
      const after = haystack[from] ?? " ";
      if (/[\p{L}\p{N}_]/u.test(after)) continue;
      hits.push(role);
      break;
    }
  }
  return hits;
}

/**
 * Ghi lại danh sách user được @mention cho một tin nhắn (xoá cũ → thêm mới).
 * Gọi sau khi tạo và sau khi sửa tin; tin bị xoá thì bảng tự CASCADE.
 * Username không tồn tại → bỏ qua, không lỗi (vẫn hiển thị nguyên văn).
 *
 * `allowEveryoneMention` = người gửi có `MANAGE_MESSAGES` hay không: nhắc tới
 * role `@everyone` là **ping cả server**, nên chỉ người trực kênh mới được làm.
 * Không có cờ này thì nội dung vẫn hiện bình thường, chỉ không ghi nhận ai.
 */
export async function syncMessageMentions(
  pool: Pool,
  messageId: string,
  channelId: string,
  content: string,
  options: { allowEveryoneMention?: boolean } = {},
): Promise<void> {
  await pool.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);

  const names = extractMentions(content);
  if (names.length > 0) {
    const users = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = ANY($1::text[])",
      [names],
    );
    if (users.rows.length > 0) {
      const placeholders = users.rows.map(
        (_, index) => `($1, $${index + 2}, $${users.rows.length + 2})`,
      );
      await pool.query(
        `INSERT INTO message_mentions (message_id, user_id, channel_id)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT DO NOTHING`,
        [messageId, ...users.rows.map((row) => row.id), channelId],
      );
    }
  }

  // Role chỉ tồn tại trong guild; DM không có role để nhắc.
  const channel = await pool.query<{ guild_id: string | null }>(
    "SELECT guild_id FROM channels WHERE id = $1",
    [channelId],
  );
  const guildId = channel.rows[0]?.guild_id ?? null;
  if (guildId === null) return;

  const roleRows = await pool.query<{ id: string; name: string; is_everyone: boolean }>(
    "SELECT id, name, is_everyone FROM roles WHERE guild_id = $1",
    [guildId],
  );
  const roles = roleRows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    isEveryone: row.is_everyone,
  }));
  const matched = extractRoleMentions(content, roles).filter(
    (role) => role.isEveryone !== true || options.allowEveryoneMention === true,
  );
  if (matched.length === 0) return;

  // Một câu INSERT ... SELECT: người trong role được ghi nhận mà không cần kéo
  // danh sách thành viên về Node (server 5 000 người vẫn chỉ một vòng DB).
  //
  // `@everyone` **không** có dòng trong `member_roles` (ai vào server cũng có),
  // nên nhắc `@everyone` phải lấy toàn bộ `guild_members`; nếu chỉ join
  // `member_roles` thì câu lệnh chạy êm mà **không ping được ai** — đúng kiểu lỗi
  // im lặng khó thấy nhất.
  const mentionsEveryone = matched.some((role) => role.isEveryone === true);
  await pool.query(
    `INSERT INTO message_mentions (message_id, user_id, channel_id)
     SELECT DISTINCT $1::bigint, gm.user_id, $2::bigint
       FROM guild_members gm
       LEFT JOIN member_roles mr
         ON mr.guild_id = gm.guild_id
        AND mr.user_id = gm.user_id
        AND mr.role_id = ANY($4::bigint[])
      WHERE gm.guild_id = $3::bigint
        AND gm.user_id <> $5::bigint
        AND (mr.user_id IS NOT NULL OR $7::boolean)
      LIMIT $6
     ON CONFLICT DO NOTHING`,
    [
      messageId,
      channelId,
      guildId,
      matched.map((role) => role.id),
      await authorOf(pool, messageId),
      MAX_ROLE_MENTION_RECIPIENTS,
      mentionsEveryone,
    ],
  );
}

/** Tác giả tin — để không tự ping chính mình khi nhắc role mình đang có. */
async function authorOf(pool: Pool, messageId: string): Promise<string> {
  const result = await pool.query<{ author_id: string }>(
    "SELECT author_id FROM messages WHERE id = $1",
    [messageId],
  );
  return result.rows[0]?.author_id ?? "0";
}
