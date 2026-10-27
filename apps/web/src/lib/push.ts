import { ApiError } from "@umaru/sdk";

/**
 * Thông báo đẩy khi **đã đóng tab** (Web Push / VAPID).
 *
 * Khác hẳn `notifications.ts` (thông báo của trình duyệt khi tab còn mở). Hai
 * thứ này độc lập và có cách hỏng khác nhau:
 *
 * | Hỏng | Nghĩa là | Người dùng sửa bằng |
 * |---|---|---|
 * | `Notification.permission === "denied"` | trình duyệt chặn | đổi cài đặt trang |
 * | server trả 503 | server chưa cấu hình VAPID | báo người vận hành |
 * | `!("serviceWorker" in navigator)` | trình duyệt không hỗ trợ | dùng trình duyệt khác |
 *
 * Phần "quyết định" ở đây là hàm thuần để test được; phần chạm API trình duyệt
 * nằm trong `PushService` và chỉ chạy trong trình duyệt thật.
 */

export type PushStatus =
  | "unsupported"
  | "blocked"
  | "off"
  | "on"
  /** Server chưa cấu hình VAPID (503) — không phải lỗi của người dùng. */
  | "unavailable"
  | "error";

export const PUSH_ENABLED_KEY = "umaru.push.enabled";

/** Lý do dừng lại của một lần bật push, để UI nói đúng thứ cần sửa. */
export interface PushOutcome {
  status: PushStatus;
  /** Khoá i18n cho dòng gợi ý; `null` khi mọi thứ ổn. */
  hintKey:
    | "pushHintOn"
    | "pushHintOff"
    | "pushHintBlocked"
    | "pushHintUnsupported"
    | "pushHintUnavailable"
    | "pushHintError"
    | null;
}

/**
 * Quyết định trạng thái từ các điều kiện thật của môi trường. Tách riêng để
 * test được mọi tổ hợp mà không cần trình duyệt.
 */
export function pushStatusFrom(input: {
  supported: boolean;
  permission: "default" | "granted" | "denied";
  subscribed: boolean;
  serverEnabled: boolean;
}): PushStatus {
  if (!input.supported) return "unsupported";
  if (input.permission === "denied") return "blocked";
  if (!input.serverEnabled) return "unavailable";
  if (input.subscribed && input.permission === "granted") return "on";
  return "off";
}

const HINTS: Record<PushStatus, NonNullable<PushOutcome["hintKey"]>> = {
  unsupported: "pushHintUnsupported",
  blocked: "pushHintBlocked",
  off: "pushHintOff",
  on: "pushHintOn",
  unavailable: "pushHintUnavailable",
  error: "pushHintError",
};

export function pushHintKey(status: PushStatus): NonNullable<PushOutcome["hintKey"]> {
  return HINTS[status];
}

/**
 * Khoá VAPID dạng base64url → bytes cho `applicationServerKey`.
 *
 * Trình duyệt yêu cầu **bytes thật**, không nhận chuỗi; và base64url không có
 * padding nên phải tự thêm `=` trước khi giải mã. Đây là chỗ hay sai nhất khi
 * làm Web Push: truyền nguyên chuỗi vào thì `subscribe()` ném `InvalidAccessError`
 * với thông báo không nói gì về nguyên nhân.
 */
export function decodePushPublicKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const normalized = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Khoá công khai VAPID của P-256 là 65 byte, byte đầu `0x04` (không nén). */
export function isValidPushPublicKey(publicKey: string): boolean {
  try {
    const bytes = decodePushPublicKey(publicKey);
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch {
    return false;
  }
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Đổi `PushSubscription` của trình duyệt thành body gửi server. Dùng `toJSON()`
 * (có ở mọi trình duyệt hỗ trợ push) và kiểm lại khoá — subscription thiếu khoá
 * thì server sẽ từ chối 400, nhưng báo lỗi ở đây rõ nghĩa hơn.
 */
export function toPushSubscriptionPayload(subscription: {
  endpoint: string;
  toJSON: () => unknown;
}): PushSubscriptionPayload | null {
  const json = subscription.toJSON();
  if (typeof json !== "object" || json === null) return null;
  const record = json as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof record.endpoint === "string" ? record.endpoint : subscription.endpoint;
  const p256dh = record.keys?.p256dh;
  const auth = record.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length === 0 || auth.length === 0) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Phân loại lỗi khi bật/tắt push thành trạng thái + gợi ý cho người dùng. */
export function classifyPushError(error: unknown): PushOutcome {
  if (error instanceof ApiError && error.status === 503) {
    return { status: "unavailable", hintKey: "pushHintUnavailable" };
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return { status: "blocked", hintKey: "pushHintBlocked" };
  }
  if (name === "NotSupportedError") {
    return { status: "unsupported", hintKey: "pushHintUnsupported" };
  }
  return { status: "error", hintKey: "pushHintError" };
}

/** API tối thiểu cần cho `PushService` — bơm client thật hoặc giả trong test. */
export interface PushApi {
  getPushPublicKey(): Promise<{ publicKey: string }>;
  savePushSubscription(input: PushSubscriptionPayload): Promise<void>;
  deletePushSubscription(endpoint: string): Promise<void>;
  sendTestPush(): Promise<{ delivered: number; failed: number }>;
}

/** Phần chạm API trình duyệt. Chỉ gọi trong trình duyệt thật. */
export class PushService {
  private constructor(
    private readonly api: PushApi,
    private readonly registration: ServiceWorkerRegistration,
  ) {}

  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in globalThis &&
      typeof Notification !== "undefined"
    );
  }

  /** Đăng ký service worker và dựng `PushService`. */
  static async load(api: PushApi): Promise<PushService> {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return new PushService(api, registration);
  }

  async currentSubscription(): Promise<PushSubscription | null> {
    return this.registration.pushManager.getSubscription();
  }

  /**
   * Bật push. **Phải gọi từ một thao tác người dùng** (bấm nút): xin quyền tự
   * động lúc tải trang sẽ bị chặn và mất quyền vĩnh viễn.
   */
  async enable(): Promise<PushStatus> {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
    const { publicKey } = await this.api.getPushPublicKey();
    if (!isValidPushPublicKey(publicKey)) {
      throw new Error("Khoá VAPID của server không hợp lệ");
    }
    const existing = await this.currentSubscription();
    const subscription =
      existing ??
      (await this.registration.pushManager.subscribe({
        // Bắt buộc `true` ở Chrome: mọi push phải hiện thông báo cho người dùng.
        userVisibleOnly: true,
        applicationServerKey: decodePushPublicKey(publicKey),
      }));
    const payload = toPushSubscriptionPayload(subscription);
    if (payload === null) throw new Error("Subscription thiếu khoá");
    await this.api.savePushSubscription(payload);
    return "on";
  }

  /** Tắt push: huỷ ở server trước, rồi huỷ ở trình duyệt. */
  async disable(): Promise<PushStatus> {
    const subscription = await this.currentSubscription();
    if (subscription !== null) {
      await this.api.deletePushSubscription(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe();
    }
    return "off";
  }

  /**
   * Đồng bộ khi mở app: đã có subscription thì đăng ký lại với server. Cần thiết
   * vì endpoint gắn với **tài khoản đang đăng nhập** — đổi tài khoản trên cùng
   * trình duyệt thì server phải trỏ thông báo sang người mới.
   */
  async sync(): Promise<PushStatus> {
    const subscription = await this.currentSubscription();
    if (subscription === null || Notification.permission !== "granted") return "off";
    const payload = toPushSubscriptionPayload(subscription);
    if (payload === null) return "off";
    try {
      await this.api.savePushSubscription(payload);
      return "on";
    } catch (error) {
      return classifyPushError(error).status;
    }
  }

  /** Gửi thử — cách duy nhất để biết push có thật sự tới máy này. */
  async sendTest(): Promise<{ delivered: number; failed: number }> {
    return this.api.sendTestPush();
  }
}
