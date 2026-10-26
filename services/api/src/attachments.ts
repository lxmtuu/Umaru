import type { Attachment, Message, Snowflake } from "@umaru/protocol";
import type { Pool } from "./db.js";
import { mapMessage, type MessageRow } from "./mappers.js";
import { loadReactionsByMessage } from "./reactions.js";
import { loadEmbedsByMessage } from "./embeds/store.js";
import { loadPollsByMessage } from "./polls.js";

/**
 * Truy vấn + ánh xạ bảng `attachments`.
 *
 * Tách khỏi route vì ba nơi cần cùng logic: danh sách tin, gửi tin, và mentions
 * inbox. Luôn nạp theo lô (`message_id = ANY(...)`) để một trang 50 tin không
 * sinh 50 câu SQL.
 */

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  url: string;
  size: string | number;
  mime_type: string;
  width: number | null;
  height: number | null;
}

export function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id as Snowflake,
    filename: row.filename,
    url: row.url,
    size: Number(row.size),
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
  };
}

const ATTACHMENT_COLUMNS = "id, message_id, filename, url, size, mime_type, width, height";

/** URL phục vụ file — tương đối gốc API để client ghép baseUrl. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/v1/attachments/${attachmentId}`;
}

export async function loadAttachmentsByMessage(
  pool: Pool,
  messageIds: string[],
): Promise<Map<string, Attachment[]>> {
  const byMessage = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return byMessage;

  const result = await pool.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
      WHERE message_id = ANY($1::bigint[])
      ORDER BY id`,
    [messageIds],
  );
  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(mapAttachment(row));
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

/**
 * `mapMessage` + nạp attachment và reaction theo lô (mỗi thứ một câu SQL cho cả
 * trang).
 *
 * `viewerId` là **bắt buộc**: reaction có cờ `me` tính theo người xem, nên không
 * có "bản chung" đúng cho mọi người. Để tuỳ chọn thì sớm muộn cũng có route quên
 * truyền và trả `me: false` cho chính người vừa thả.
 */
export async function mapMessagesWithAttachments(
  pool: Pool,
  rows: MessageRow[],
  viewerId: string,
): Promise<Message[]> {
  const messageIds = rows.map((row) => row.id);
  const [byMessage, reactions, embeds, polls] = await Promise.all([
    loadAttachmentsByMessage(pool, messageIds),
    loadReactionsByMessage(pool, messageIds, viewerId),
    loadEmbedsByMessage(pool, messageIds),
    loadPollsByMessage(pool, messageIds, viewerId),
  ]);
  return rows.map((row) => {
    const message = mapMessage(row);
    message.attachments = byMessage.get(row.id) ?? [];
    message.reactions = reactions.get(row.id) ?? [];
    message.embeds = embeds.get(row.id) ?? [];
    message.poll = polls.get(row.id) ?? null;
    return message;
  });
}
