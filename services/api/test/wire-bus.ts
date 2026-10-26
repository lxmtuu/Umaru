import type { BusMessage, EventBus } from "../src/gateway/bus.js";

/**
 * Bus "dây" dùng chung cho test nhiều node: hai đầu nói chuyện với nhau trong
 * một tiến trình, mô phỏng Redis pub/sub mà không cần Redis server.
 *
 * Giữ đúng luật của pub/sub thật: kết nối đã publish **không** nhận lại message
 * của chính nó. Nhờ vậy test bắt được lỗi "node gửi trùng cho chính nó".
 */
export class WireHub {
  /** Message đã đi qua dây — test soi được nội dung/thứ tự. */
  readonly published: BusMessage[] = [];
  private readonly handlers = new Map<string, (message: BusMessage) => void>();

  end(name: string): EventBus {
    return {
      publish: (message) => {
        this.published.push(message);
        for (const [key, handler] of this.handlers) {
          if (key === name) continue;
          setImmediate(() => handler(message));
        }
      },
      subscribe: (handler) => {
        this.handlers.set(name, handler);
      },
      close: async () => {
        this.handlers.delete(name);
      },
    };
  }
}
