import type { Pool } from "./db.js";

/**
 * Chặn (block) giữa hai người.
 *
 * Quy ước dữ liệu: dùng bảng `relationships` sẵn có với `type = 'blocked'`,
 * **chỉ một chiều** (A→B nghĩa là A chặn B) — khớp với ghi chú trong
 * `db/migrations/0001_init.sql`.
 *
 * Nhưng hành vi hiệu lực là **hai chiều**, vì mục đích của block là cắt liên lạc:
 * - người bị chặn không mở/nhắn được DM tới người chặn,
 * - người chặn cũng không nhắn được (tránh biến block thành "tôi vẫn nói được"),
 * - DM cũ giữa hai người trở nên vô hình với cả hai (không đọc được tin cũ),
 * - tin của người bị chặn không còn xuất hiện trong mentions/search của người chặn.
 *
 * Tin trong **kênh server** vẫn hiển thị bình thường: block là chuyện giữa hai
 * người, không phải công cụ ẩn nội dung cộng đồng (việc đó là của moderation).
 */

/** Điều kiện SQL: `$userParam` KHÔNG chặn `authorExpr` và ngược lại. */
export function notBlockedAuthorSql(userParam: string, authorExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM relationships rb
     WHERE rb.type = 'blocked'
       AND ((rb.user_id = ${userParam} AND rb.target_id = ${authorExpr})
         OR (rb.user_id = ${authorExpr} AND rb.target_id = ${userParam}))
  )`;
}

/** Hai người có chặn nhau theo bất kỳ chiều nào không. */
export async function isBlockedBetween(
  pool: Pool,
  userA: string,
  userB: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM relationships
      WHERE type = 'blocked' AND user_id = $1 AND target_id = $2
      UNION ALL
     SELECT 1 FROM relationships
      WHERE type = 'blocked' AND user_id = $2 AND target_id = $1
      LIMIT 1`,
    [userA, userB],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * DM có bị "khoá" bởi block không (tính cả chiều ngược).
 * Kênh không phải DM → luôn `false`.
 */
export async function isDmBlocked(
  pool: Pool,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await pool.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM channels c
         JOIN channel_members mine   ON mine.channel_id = c.id AND mine.user_id = $2
         JOIN channel_members theirs ON theirs.channel_id = c.id AND theirs.user_id <> mine.user_id
         JOIN relationships rb
           ON rb.type = 'blocked'
          AND ((rb.user_id = mine.user_id AND rb.target_id = theirs.user_id)
            OR (rb.user_id = theirs.user_id AND rb.target_id = mine.user_id))
        WHERE c.id = $1 AND c.type = 'dm' AND c.guild_id IS NULL
     ) AS blocked`,
    [channelId, userId],
  );
  return result.rows[0]?.blocked === true;
}

/** Danh sách id những người `userId` đã chặn. */
export async function listBlockedIds(pool: Pool, userId: string): Promise<string[]> {
  const result = await pool.query<{ target_id: string }>(
    "SELECT target_id FROM relationships WHERE type = 'blocked' AND user_id = $1",
    [userId],
  );
  return result.rows.map((row) => row.target_id);
}
