import type { GatewayEventName, VoiceStateUpdate } from "@umaru/protocol";

/**
 * Bus giữa các node gateway.
 *
 * Vì sao cần: một kết nối WebSocket chỉ sống trên **một** node. Người A nối vào
 * node 1, người B nối vào node 2 — khi A gửi tin qua REST (có thể rơi vào bất kỳ
 * node nào), node phục vụ request phải làm cho tin đó tới được session của B ở
 * node khác. Không có bus thì tin chỉ tới người "cùng node", đúng loại lỗi khó
 * thấy nhất: chạy một máy thì hoàn hảo, deploy hai máy thì nửa số người dùng
 * không nhận được tin.
 *
 * Hợp đồng giữ nhỏ có chủ ý: bus chỉ **chở** sự kiện, không quyết định ai nhận.
 * Mỗi node tự lọc theo session của mình (`deliverToChannel`…), nên quyền xem
 * kênh vẫn do node sở hữu session quyết định — không tin node gửi.
 *
 * Chọn Redis pub/sub thay vì Streams: sự kiện gateway là **tức thời**, không cần
 * phát lại (client đã có `RESUME` + replay buffer riêng). Streams sẽ thêm chi
 * phí lưu trữ + phải trim cho một nhu cầu không tồn tại.
 */

/**
 * `channel`/`guild`/`user`/`voice` = sự kiện thật cho client.
 * `control` = lệnh nội bộ giữa các node (không gửi cho client), vd. "tính lại
 * danh sách bạn cho user X vì X vừa kết bạn ở node khác".
 */
export type BusScope = "channel" | "guild" | "user" | "voice" | "control";

/** Lệnh điều khiển nội bộ — chỉ dùng trong `scope: "control"`. */
export const CONTROL_REFRESH_FRIENDS = "__REFRESH_FRIENDS";
/** Một người đổi trạng thái (online/idle/dnd/offline) — `target` = userId. */
export const CONTROL_PRESENCE = "__PRESENCE";
/** "Node mới vào, gửi tao danh sách người đang online của mày" — `target` = "". */
export const CONTROL_PRESENCE_SYNC = "__PRESENCE_SYNC";
/** Trả lời `CONTROL_PRESENCE_SYNC`: cả danh sách presence node này biết. */
export const CONTROL_PRESENCE_STATE = "__PRESENCE_STATE";
/**
 * "Session `target` giờ của tao" — node cũ bỏ bản cục bộ, **không** phát
 * offline. Có mặt để hai node không cùng gán `s` cho một session.
 */
export const CONTROL_SESSION_CLAIM = "__SESSION_CLAIM";

export interface BusMessage {
  /**
   * Node phát. Node nhận **bỏ qua** message của chính mình: nó đã fan-out tại
   * chỗ trước khi publish, làm lại sẽ gửi trùng cho mọi người.
   */
  origin: string;
  scope: BusScope;
  /** Id kênh / guild / user tuỳ `scope`. */
  target: string;
  /**
   * Tên sự kiện (`MESSAGE_CREATE`…) **hoặc** lệnh điều khiển (`__REFRESH_FRIENDS`).
   * Để `string` vì bus còn chở lệnh nội bộ không nằm trong `GatewayEventMap`;
   * chỗ nhận ép lại về `GatewayEventName` sau khi đã lọc theo `scope`.
   */
  event: GatewayEventName | string;
  data: unknown;
}

export interface EventBus {
  /** Phát cho mọi node (kể cả chính mình — bên nhận tự lọc theo `origin`). */
  publish(message: BusMessage): void;
  /** Đăng ký nhận; gọi trước khi node bắt đầu phục vụ để không lỡ sự kiện. */
  subscribe(handler: (message: BusMessage) => void): void;
  close(): Promise<void>;
}

/**
 * Bus trong bộ nhớ — dùng cho test và cho trường hợp một node (không cần Redis).
 *
 * Nó **không** tự gửi lại cho publisher (không có node khác); `setImmediate` để
 * giữ đúng thứ tự "fan-out tại chỗ trước, hàng đợi sau" như khi có Redis.
 */
export class LocalBus implements EventBus {
  private handler: ((message: BusMessage) => void) | null = null;
  readonly published: BusMessage[] = [];

  publish(message: BusMessage): void {
    // Ghi lại để test/kiểm tra cấu hình soi được; không có ai nhận.
    this.published.push(message);
  }

  subscribe(handler: (message: BusMessage) => void): void {
    this.handler = handler;
  }

  /** Chỉ dùng cho test: coi như nhận message từ một node khác. */
  inject(message: BusMessage): void {
    this.handler?.(message);
  }

  async close(): Promise<void> {
    this.handler = null;
  }
}

/** Kiểm hình dạng message từ bus trước khi đem fan-out (dữ liệu qua mạng). */
export function isBusMessage(value: unknown): value is BusMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const scope = record["scope"];
  return (
    typeof record["origin"] === "string" &&
    (scope === "channel" ||
      scope === "guild" ||
      scope === "user" ||
      scope === "voice" ||
      scope === "control") &&
    typeof record["target"] === "string" &&
    typeof record["event"] === "string" &&
    record["data"] !== undefined
  );
}

/** Kiểu dữ liệu đi kèm của một scope, để chỗ gọi không phải cast lung tung. */
export type BusPayload = {
  channel: unknown;
  guild: unknown;
  user: unknown;
  voice: VoiceStateUpdate;
};
