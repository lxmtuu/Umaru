import type { ThreadSummary } from "@umaru/protocol";
import type { Pool } from "../db.js";

/**
 * Truy vấn thread.
 *
 * Một thread = một dòng `channels` (type `guild_thread`) + một dòng
 * `channel_threads` (tin gốc, chủ, đếm tin, hoạt động, lưu trữ). Xem
 * `db/migrations/0017_threads.sql` để biết vì sao tách như vậy.
 */

export interface ThreadRow {
  id: string;
  parent_channel_id: string;
  root_message_id: string | null;
  name: string;
  owner_id: string | null;
  message_count: number;
  last_activity_at: Date;
  archived_at: Date | null;
  created_at: Date;
}

export function mapThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id as ThreadSummary["id"],
    parentChannelId: row.parent_channel_id as ThreadSummary["parentChannelId"],
    rootMessageId:
      row.root_message_id === null ? null : (row.root_message_id as ThreadSummary["rootMessageId"]),
    name: row.name,
    ownerId: row.owner_id === null ? null : (row.owner_id as ThreadSummary["ownerId"]),
    messageCount: Number(row.message_count),
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    archived: row.archived_at !== null,
  };
}

export const THREAD_COLUMNS = `t.channel_id AS id, t.parent_channel_id, t.root_message_id, c.name,
       t.owner_id, t.message_count, t.last_activity_at, t.archived_at, t.created_at`;

/** Danh sách thread của một kênh cha (đang mở hoặc đã lưu trữ). */
export async function listThreads(
  pool: Pool,
  parentChannelId: string,
  options: { archived: boolean },
): Promise<ThreadSummary[]> {
  const result = await pool.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM channel_threads t
       JOIN channels c ON c.id = t.channel_id
      WHERE t.parent_channel_id = $1
        AND (t.archived_at IS NOT NULL) = $2
      ORDER BY t.last_activity_at DESC, t.created_at DESC`,
    [parentChannelId, options.archived],
  );
  return result.rows.map(mapThread);
}

/** Thread đang mở của **mọi** kênh user xem được — gửi kèm `READY`. */
export async function listActiveThreadsForGuilds(
  pool: Pool,
  guildIds: string[],
): Promise<ThreadSummary[]> {
  if (guildIds.length === 0) return [];
  const result = await pool.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM channel_threads t
       JOIN channels c ON c.id = t.channel_id
      WHERE c.guild_id = ANY($1::bigint[])
        AND t.archived_at IS NULL
      ORDER BY t.last_activity_at DESC`,
    [guildIds],
  );
  return result.rows.map(mapThread);
}

export async function loadThread(pool: Pool, channelId: string): Promise<ThreadSummary | null> {
  const result = await pool.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM channel_threads t
       JOIN channels c ON c.id = t.channel_id
      WHERE t.channel_id = $1`,
    [channelId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapThread(row);
}

/**
 * Đánh dấu có tin mới: tăng đếm + dời mốc hoạt động.
 *
 * Gọi ở **mọi** tin nhắn (kể cả kênh thường) — câu này là một lần tra PK trên
 * bảng rỗng với kênh thường, rẻ hơn nhiều so với việc rẽ nhánh ở đường nóng của
 * route gửi tin.
 */
export async function touchThread(pool: Pool, channelId: string): Promise<void> {
  await pool.query(
    `UPDATE channel_threads
        SET last_activity_at = now(), message_count = message_count + 1
      WHERE channel_id = $1`,
    [channelId],
  );
}

export async function decrementThreadMessages(pool: Pool, channelId: string): Promise<void> {
  await pool.query(
    `UPDATE channel_threads
        SET message_count = GREATEST(message_count - 1, 0)
      WHERE channel_id = $1`,
    [channelId],
  );
}

/**
 * Tự lưu trữ thread không có tin mới trong `minutes` phút.
 *
 * Quét **lười** (khi ai đó mở danh sách thread) thay vì cron: đúng dữ liệu ở
 * thời điểm người ta nhìn, không cần thêm tiến trình nền cho một việc mà không
 * ai thấy khi không mở panel. Trả về id những thread vừa bị lưu trữ để route
 * phát `THREAD_UPDATE`.
 */
export async function archiveIdleThreads(
  pool: Pool,
  parentChannelId: string,
  minutes: number,
): Promise<string[]> {
  const result = await pool.query<{ channel_id: string }>(
    `UPDATE channel_threads
        SET archived_at = now()
      WHERE parent_channel_id = $1
        AND archived_at IS NULL
        AND last_activity_at < now() - make_interval(mins => $2)
      RETURNING channel_id`,
    [parentChannelId, minutes],
  );
  return result.rows.map((row) => row.channel_id);
}

/** Thread của kênh này có đang bị lưu trữ không (null = không phải thread). */
export async function isThreadArchived(pool: Pool, channelId: string): Promise<boolean | null> {
  const result = await pool.query<{ archived_at: Date | null }>(
    "SELECT archived_at FROM channel_threads WHERE channel_id = $1",
    [channelId],
  );
  const row = result.rows[0];
  return row === undefined ? null : row.archived_at !== null;
}
