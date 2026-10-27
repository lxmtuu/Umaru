import type { Config } from "../config.js";

/**
 * Nén frame gateway (`permessage-deflate`).
 *
 * Frame của Umaru là JSON và lặp khoá khắp nơi (`channelId`, `messageId`,
 * `userId`, `createdAt`…). Một `READY` của server vài chục người dùng là vài
 * chục KB nhưng phần lớn là **cấu trúc**, không phải thông tin mới — nén được
 * 70–85% mà không mất gì. Trình duyệt nào cũng hỗ trợ, và `ws` (server + client
 * Node) cũng vậy, nên không cần đổi protocol hay viết lại codec.
 *
 * Ba quyết định đáng ghi lại:
 *
 * 1. **Ngưỡng (`threshold`)** — chỉ nén frame ≥ `gatewayCompressThreshold`
 *    (mặc định 1 KiB). `HEARTBEAT`/`TYPING_START` chỉ ~60–120 byte; nén chúng
 *    tốn CPU + cấp phát context zlib mà thu về gần 0. Frame lớn (READY,
 *    MESSAGE_CREATE kèm markdown, GUILD_CREATE) mới là chỗ có lợi.
 * 2. **`clientNoContextTakeover` + `serverNoContextTakeover` = true** — mỗi
 *    message nén độc lập, không dùng lại từ điển của message trước. Đắt hơn một
 *    chút về CPU nhưng **không tạo kênh rò rỉ kiểu BREACH**: nếu từ điển dùng
 *    chung, kẻ tấn công chèn được nội dung của mình vào cùng luồng nén với dữ
 *    liệu riêng của người khác (tin nhắn, tên kênh, danh sách thành viên) thì
 *    có thể suy ra thông tin từ độ dài nén.
 * 3. **`maxPayload` vẫn tính trên dữ liệu đã giải nén** — trần 4 KiB của spec §1
 *    không bị nới ra chỉ vì frame bị nén nhỏ hơn.
 */

export interface GatewayCompressionOptions {
  /** Frame nhỏ hơn mức này (byte) không nén. */
  threshold: number;
  clientNoContextTakeover: boolean;
  serverNoContextTakeover: boolean;
  zlibDeflateOptions: { level: number; memLevel: number };
}

/** Mức nén 6: điểm cân bằng của zlib; 9 chỉ nhanh hơn ~7% mà tốn CPU gấp đôi. */
const DEFLATE_LEVEL = 6;

/**
 * Tuỳ chọn cho `WebSocketServer`/`@fastify/websocket`.
 *
 * Trả `false` (không phải object rỗng) khi tắt: `ws` hiểu `false` là "không
 * đàm phán extension này", còn `{}` là "bật với mặc định".
 */
export function gatewayCompressionOptions(
  config: Pick<Config, "gatewayCompress" | "gatewayCompressThreshold">,
): GatewayCompressionOptions | false {
  if (!config.gatewayCompress) return false;
  return {
    threshold: config.gatewayCompressThreshold,
    // Xem lý do ở đầu file: không tái sử dụng từ điển giữa các message.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    zlibDeflateOptions: { level: DEFLATE_LEVEL, memLevel: 8 },
  };
}
