import type { Attachment, Message, Snowflake } from "@umaru/protocol";
import type { Pool } from "./db.js";
import { mapMessage, type MessageRow } from "./mappers.js";

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

/** `mapMessage` + nạp attachment theo lô (một câu SQL cho cả trang). */
export async function mapMessagesWithAttachments(
  pool: Pool,
  rows: MessageRow[],
): Promise<Message[]> {
  const byMessage = await loadAttachmentsByMessage(
    pool,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const message = mapMessage(row);
    message.attachments = byMessage.get(row.id) ?? [];
    return message;
  });
}
