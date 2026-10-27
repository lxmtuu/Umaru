import {
  GatewayOpcode,
  decodeGatewayPayload,
  encodeGatewayPayload,
  type DispatchPayload,
  type GatewayEventMap,
  type GatewayEventName,
  type GatewayReceivePayload,
  type GatewaySendPayload,
  type PresenceStatus,
} from "@umaru/protocol";
import { computeBackoffMs } from "./backoff.js";

export type GatewayState = "idle" | "connecting" | "ready" | "reconnecting" | "closed";

export interface SocketEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
}

/** Khung WebSocket tối thiểu — trình duyệt / Node / React Native đều thỏa; test inject bản fake. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketEventLike) => void,
  ): void;
}

const WS_OPEN = 1;

export interface GatewayClientOptions {
  /** URL gateway đầy đủ do GET /gateway trả về. */
  url: string;
  /** Access token lúc tạo client. Bỏ qua nếu có `getToken`. */
  token: string;
  /**
   * Đọc token **hiện tại** mỗi lần identify/resume. Dùng khi app có thể refresh
   * token trong lúc socket đang sống (web truyền `getAccessToken`).
   */
  getToken?: () => string | null;
  /**
   * Gọi khi server đóng `4000` (token hết hạn/không hợp lệ), spec §2.1: client
   * refresh rồi reconnect. Trả access token mới, hoặc `null` khi không refresh
   * được → client về `closed` (đăng xuất mềm) thay vì thử lại vô hạn.
   */
  onAuthFailure?: () => Promise<string | null>;
  wsFactory?: (url: string) => WebSocketLike;
  random?: () => number;
  /** Số lần retry tối đa trước khi bỏ cuộc (mặc định 20). */
  maxReconnectAttempts?: number;
}

type EventHandler<E extends GatewayEventName> = (data: GatewayEventMap[E]) => void;

/**
 * Gateway client: identify → resume sau khi mất kết nối, heartbeat + phát hiện
 * connection zombie, exponential backoff. Trạng thái session (`sessionId`, `seq`)
 * phải được persist để resume qua lần restart app — G1 sẽ lưu xuống storage.
 */
export class GatewayClient {
  state: GatewayState = "idle";

  private ws: WebSocketLike | null = null;
  private sessionId: string | null = null;
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingHeartbeatAck = false;
  private reconnectAttempt = 0;
  private closedByUser = false;
  /** Token lấy được từ `onAuthFailure`, ưu tiên hơn `options.token`. */
  private refreshedToken: string | null = null;
  private authFailureCount = 0;
  private authRefreshInFlight = false;
  /** hẹn giờ cho heartbeat đầu tiên (jitter) — tách khỏi interval định kỳ. */
  private heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Map<GatewayEventName, Set<EventHandler<never>>>();
  private readonly stateListeners = new Set<(state: GatewayState) => void>();

  private readonly wsFactory: (url: string) => WebSocketLike;
  /** Trạng thái người dùng đã chọn — gửi lại sau mỗi lần identify/resume. */
  private desiredPresence: PresenceStatus | null = null;
  private readonly random: () => number;
  private readonly maxReconnectAttempts: number;

  constructor(private readonly options: GatewayClientOptions) {
    this.wsFactory =
      options.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.random = options.random ?? Math.random;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
  }

  /** Đăng ký handler cho một sự kiện; trả về hàm hủy đăng ký. */
  on<E extends GatewayEventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler<never>);
    return () => {
      set?.delete(handler as EventHandler<never>);
    };
  }

  onStateChange(handler: (state: GatewayState) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  connect(): void {
    this.closedByUser = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) return; // đã có kết nối đang mở
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** Ngắt hẳn, không tự kết nối lại. */
  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState("closed");
  }

  private currentToken(): string | null {
    return this.refreshedToken ?? this.options.getToken?.() ?? this.options.token;
  }

  /** Session hiện tại (để persist và resume sau restart). */
  getSession(): { sessionId: string; seq: number } | null {
    return this.sessionId === null ? null : { sessionId: this.sessionId, seq: this.seq };
  }

  private openSocket(): void {
    const ws = this.wsFactory(this.options.url);
    this.ws = ws;
    this.setState(this.sessionId !== null ? "reconnecting" : "connecting");
    ws.addEventListener("open", () => this.handleOpen());
    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("close", (event) => this.handleClose(event.code ?? null));
    ws.addEventListener("error", () => {
      /* sự kiện close sẽ tới ngay sau đó */
    });
  }

  private handleOpen(): void {
    const token = this.currentToken() ?? this.options.token;
    if (this.sessionId !== null) {
      this.send({
        op: GatewayOpcode.Resume,
        d: { token, sessionId: this.sessionId, seq: this.seq },
      });
    } else {
      this.send({
        op: GatewayOpcode.Identify,
        d: {
          token,
          properties: {
            os: typeof navigator !== "undefined" ? (navigator.platform || "unknown") : "node",
            browser: "umaru",
            device: "umaru",
          },
        },
      });
    }
  }

  private handleMessage(event: SocketEventLike): void {
    if (event.data === undefined || event.data === null) return;
    let payload: GatewayReceivePayload;
    try {
      payload = decodeGatewayPayload(event.data);
    } catch {
      // Frame sai protocol → đóng kết nối; lộ trình reconnect sẽ chạy
      this.ws?.close();
      return;
    }
    this.handlePayload(payload);
  }

  private handlePayload(payload: GatewayReceivePayload): void {
    switch (payload.op) {
      case GatewayOpcode.Hello:
        this.startHeartbeat(payload.d.heartbeat_interval);
        break;
      case GatewayOpcode.Heartbeat:
        this.sendHeartbeat();
        break;
      case GatewayOpcode.HeartbeatAck:
        this.awaitingHeartbeatAck = false;
        break;
      case GatewayOpcode.Reconnect:
        this.ws?.close(); // handleClose sẽ tự lên lịch reconnect
        break;
      case GatewayOpcode.InvalidSession:
        if (!payload.d) {
          this.sessionId = null;
          this.seq = 0;
        }
        this.scheduleReconnect(Math.round(1000 + this.random() * 4000));
        this.ws?.close();
        break;
      case GatewayOpcode.Dispatch:
        this.handleDispatch(payload);
        break;
    }
  }

  /**
   * Dedupe theo `s` (spec §9): `READY` mở một session mới nên đặt lại bộ đếm,
   * còn mọi dispatch khác phải tăng dần. Frame trùng/`s` cũ bị bỏ — replay sau
   * resume có thể chồng lấn nếu server gửi lại, và xử lý trùng tin nhắn hai lần
   * là lỗi thấy được (tin nhắn lặp trong khung chat).
   */
  private handleDispatch(payload: DispatchPayload): void {
    const isNewSession = payload.t === "READY";
    if (!isNewSession && payload.s <= this.seq) return;
    this.seq = payload.s;
    const { t, d } = payload;
    switch (t) {
      case "READY": {
        const data = d as GatewayEventMap["READY"];
        this.sessionId = data.sessionId;
        this.reconnectAttempt = 0;
        this.authFailureCount = 0;
        this.refreshedToken = null;
        this.setState("ready");
        this.resendPresence();
        break;
      }
      case "RESUMED":
        this.reconnectAttempt = 0;
        this.authFailureCount = 0;
        this.setState("ready");
        this.resendPresence();
        break;
      default:
        break;
    }
    this.emit(t, d);
  }

  /** Gửi lại trạng thái đã chọn sau khi session mới sẵn sàng (xem `updatePresence`). */
  private resendPresence(): void {
    if (this.desiredPresence === null) return;
    this.send({ op: GatewayOpcode.PresenceUpdate, d: { status: this.desiredPresence } });
  }

  private emit<E extends GatewayEventName>(event: E, data: GatewayEventMap[E]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      (handler as EventHandler<E>)(data);
    }
  }

  /**
   * Heartbeat có **jitter ở nhịp đầu** (spec §5): hàng nghìn client nhận HELLO
   * cùng lúc mà gửi đúng chu kỳ thì server bị "thundering herd" mỗi lần restart.
   * Lệch ngẫu nhiên trong một interval là đủ tản tải, các nhịp sau vẫn đều.
   *
   * Đặt nhịp đầu muộn (không phải sớm) để không bao giờ đánh thức server trước
   * thời điểm nó chờ, và không vượt trần 2 frame dư của bucket HEARTBEAT.
   */
  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.awaitingHeartbeatAck = false;
    const jitterMs = Math.floor(this.random() * intervalMs);
    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = null;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, jitterMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatJitterTimer !== null) {
      clearTimeout(this.heartbeatJitterTimer);
      this.heartbeatJitterTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Đổi trạng thái hiển thị của chính mình (Trực tuyến / Không làm phiền /
   * Đang chờ / Ẩn). Ghi nhớ để **gửi lại sau khi nối lại** — server mất trạng
   * thái khi socket đóng, nếu không nhớ thì mỗi lần rớt mạng người đang để
   * "Không làm phiền" lại hiện thành "Trực tuyến".
   */
  updatePresence(status: PresenceStatus): void {
    this.desiredPresence = status;
    if (this.state === "ready") {
      this.send({ op: GatewayOpcode.PresenceUpdate, d: { status } });
    }
  }

  private sendHeartbeat(): void {
    if (this.awaitingHeartbeatAck) {
      // Không có ack → connection "zombie": đóng để reconnect
      this.ws?.close();
      return;
    }
    this.awaitingHeartbeatAck = true;
    this.send({ op: GatewayOpcode.Heartbeat, d: this.seq > 0 ? this.seq : null });
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.reconnectTimer !== null || this.closedByUser) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.setState("closed");
      return;
    }
    const delay = delayMs ?? computeBackoffMs({ attempt: this.reconnectAttempt, random: this.random });
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /**
   * Xử lý close theo mã (spec §2.1):
   * - `4003` (session không còn) → xoá session để lần sau IDENTIFY, không RESUME vô ích.
   * - `4004` (rate limited) → chờ ≥ 5 s mới nối lại, tránh vòng lặp tự đốt rate limit.
   * - `4000` (token hết hạn) → gọi `onAuthFailure` để refresh rồi nối lại (spec §2.1);
   *   không có hook hoặc refresh hỏng → `closed` (đăng xuất mềm).
   * - Còn lại → backoff thường.
   */
  private handleClose(code: number | null = null): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.closedByUser) {
      this.setState("closed");
      return;
    }
    if (code === 4003) {
      this.sessionId = null;
      this.seq = 0;
    }
    if (code === 4000) {
      void this.recoverAuth();
      return;
    }
    const delay = computeBackoffMs({ attempt: this.reconnectAttempt, random: this.random });
    this.scheduleReconnect(code === 4004 ? Math.max(delay, 5_000) : delay);
  }

  /**
   * `4000` → xin token mới. Giới hạn 2 lần liên tiếp để token hỏng/refresh hỏng
   * không tạo vòng lặp vô hạn; thành công thì `READY`/`RESUMED` đặt lại bộ đếm.
   */
  private async recoverAuth(): Promise<void> {
    this.authFailureCount += 1;
    const refresh = this.options.onAuthFailure;
    if (refresh === undefined || this.authFailureCount > 2 || this.authRefreshInFlight) {
      this.setState("closed");
      return;
    }
    this.authRefreshInFlight = true;
    this.setState("reconnecting");
    let token: string | null = null;
    try {
      token = await refresh();
    } catch {
      token = null;
    } finally {
      this.authRefreshInFlight = false;
    }
    if (token === null || token.length === 0) {
      this.setState("closed");
      return;
    }
    this.refreshedToken = token;
    // Session cũ vẫn còn hạn (server giữ TTL) → resume để không mất event nào.
    this.scheduleReconnect(500);
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: GatewayState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateListeners) handler(state);
  }

  private send(payload: GatewaySendPayload): void {
    if (this.ws === null || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(encodeGatewayPayload(payload));
  }
}
