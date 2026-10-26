import type { Embed } from "@umaru/protocol";
import type { Pool } from "../db.js";

/**
 * Truy vấn bảng `message_embeds`.
 *
 * Nạp theo lô giống attachments/reactions: một trang 50 tin chỉ một câu SQL.
 */

export interface EmbedRow {
  message_id: string;
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
}

export function mapEmbed(row: EmbedRow): Embed {
  return {
    url: row.url,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    imageUrl: row.image_url,
  };
}

export async function loadEmbedsByMessage(
  pool: Pool,
  messageIds: string[],
): Promise<Map<string, Embed[]>> {
  const byMessage = new Map<string, Embed[]>();
  if (messageIds.length === 0) return byMessage;

  const result = await pool.query<EmbedRow>(
    `SELECT message_id, url, title, description, site_name, image_url
       FROM message_embeds
      WHERE message_id = ANY($1::bigint[])`,
    [messageIds],
  );
  for (const row of result.rows) {
    byMessage.set(row.message_id, [mapEmbed(row)]);
  }
  return byMessage;
}

/** Ghi embed của một tin (tối đa một dòng/tin) — dùng UPSERT để sửa tin ghi đè. */
export async function saveEmbed(pool: Pool, messageId: string, embed: Embed): Promise<void> {
  await pool.query(
    `INSERT INTO message_embeds (message_id, url, title, description, site_name, image_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (message_id) DO UPDATE
        SET url = EXCLUDED.url,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            site_name = EXCLUDED.site_name,
            image_url = EXCLUDED.image_url`,
    [messageId, embed.url, embed.title, embed.description, embed.siteName, embed.imageUrl],
  );
}

export async function deleteEmbed(pool: Pool, messageId: string): Promise<void> {
  await pool.query("DELETE FROM message_embeds WHERE message_id = $1", [messageId]);
}
