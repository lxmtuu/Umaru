import type { Message, Sticker, StickerPack } from "@umaru/protocol";
import type { Pool } from "./db.js";
import { badRequest } from "./http.js";

/**
 * Sticker theo server (mục 53).
 *
 * Tách khỏi `routes.ts` phần **thuần** (giới hạn, dựng kiểu trả về) để kiểm
 * được mà không cần Postgres, và để route + bộ nạp tin dùng chung một cách
 * dựng `imageUrl` — lệch một chỗ là client 404 cả lưới sticker.
 */

/** Trần để một server không nhét cả kho ảnh vào DB của mình. */
export const MAX_PACKS_PER_GUILD = 20;
export const MAX_STICKERS_PER_PACK = 60;

/** Tên gói/sticker: như tên kênh, không rỗng, không chỉ khoảng trắng. */
export const MAX_STICKER_NAME = 40;

/** Ảnh sticker ≤ 512KB: đây là ảnh hiển thị nhỏ, không phải tệp đính kèm. */
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_STICKER_DIMENSION = 1024;

/** MIME hợp lệ — cố ý **không** nhận SVG (chứa script, phục vụ từ origin API). */
export const STICKER_MIME_TYPES = new Set([
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export interface StickerRow {
  id: string;
  pack_id: string;
  name: string;
  upload_id: string;
  mime_type: string;
  size: number;
  width: number;
  height: number;
  guild_id: string;
}

export interface StickerPackRow {
  id: string;
  guild_id: string;
  name: string;
  created_by: string;
  created_at: Date;
}

/**
 * URL ảnh sticker. Đường dẫn chứa `guildId` để route kiểm quyền **theo server**
 * mà không phải join hai bảng; `stickerId` đủ để tra `pack_id` rồi `guild_id`.
 */
export function stickerImageUrl(guildId: string, stickerId: string): string {
  return `/api/v1/guilds/${guildId}/stickers/${stickerId}/image`;
}

export function mapSticker(row: StickerRow): Sticker {
  return {
    id: row.id as Sticker["id"],
    packId: row.pack_id as Sticker["packId"],
    name: row.name,
    imageUrl: stickerImageUrl(row.guild_id, row.id),
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
  };
}

export function mapStickerPack(row: StickerPackRow, stickers: StickerRow[]): StickerPack {
  return {
    id: row.id as StickerPack["id"],
    guildId: row.guild_id as StickerPack["guildId"],
    name: row.name,
    createdBy: row.created_by as StickerPack["createdBy"],
    stickers: stickers.filter((sticker) => sticker.pack_id === row.id).map(mapSticker),
  };
}

/**
 * Chuẩn hoá tên gói/sticker: cắt khoảng trắng, gộp khoảng trắng giữa các từ.
 *
 * Gộp là chủ ý: "Cute  Cat" và "Cute Cat" hiện ra gần như giống nhau, để hai
 * tên cùng tồn tại chỉ tổ khó chọn.
 */
export function parseStickerName(value: unknown, field = "Tên"): string {
  if (typeof value !== "string") throw badRequest(`${field} phải là chuỗi`);
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw badRequest(`${field} không được để trống`);
  if ([...name].length > MAX_STICKER_NAME) {
    throw badRequest(`${field} tối đa ${MAX_STICKER_NAME} ký tự`);
  }
  return name;
}

/**
 * Kiểm kích thước ảnh sticker.
 *
 * Bắt buộc **vuông**: lưới chọn sticker và bong bóng tin đều render 1:1, nhận
 * ảnh dài thì phải crop (mất nội dung) hoặc kéo méo. Báo cả hai cạnh để người
 * dùng biết phải sửa gì.
 */
export function checkStickerDimensions(width: number, height: number): void {
  if (width !== height) {
    throw badRequest(
      `Sticker phải là ảnh vuông (hiện ${width}×${height}) — cắt lại ảnh rồi tải lên`,
    );
  }
  if (width > MAX_STICKER_DIMENSION) {
    throw badRequest(
      `Sticker tối đa ${MAX_STICKER_DIMENSION}×${MAX_STICKER_DIMENSION} pixel (hiện ${width}×${height})`,
    );
  }
}

/**
 * Nạp sticker cho một trang tin bằng **một** truy vấn.
 *
 * Tin không có sticker không xuất hiện trong map ⇒ `mapMessage` để `null`, và
 * client render tin thường.
 */
export async function loadStickersByMessage(
  pool: Pool,
  messageIds: string[],
): Promise<Map<string, Sticker>> {
  const result = new Map<string, Sticker>();
  if (messageIds.length === 0) return result;

  const rows = await pool.query<StickerRow & { message_id: string }>(
    `SELECT s.id, s.pack_id, s.name, s.upload_id, s.mime_type, s.size, s.width, s.height,
            p.guild_id, m.id AS message_id
       FROM messages m
       JOIN stickers s ON s.id = m.sticker_id
       JOIN sticker_packs p ON p.id = s.pack_id
      WHERE m.id = ANY($1::bigint[])`,
    [messageIds],
  );
  for (const row of rows.rows) {
    result.set(row.message_id, mapSticker(row));
  }
  return result;
}

/** Đính sticker vào danh sách tin đã map (dùng chung với bộ nạp attachment). */
export function attachStickers(messages: Message[], byMessage: Map<string, Sticker>): void {
  for (const message of messages) {
    message.sticker = byMessage.get(message.id) ?? null;
  }
}
