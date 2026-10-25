import {
  GatewayOpcode,
  decodeGatewayPayload,
  encodeGatewayPayload,
  type DispatchPayload,
  type GatewayEventMap,
  type GatewayEventName,
  type GatewayReceivePayload,
  type GatewaySendPayload,
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
  token: string;
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

  private readonly listeners = new Map<GatewayEventName, Set<EventHandler<never>>>();
  private readonly stateListeners = new Set<(state: GatewayState) => void>();

  private readonly wsFactory: (url: string) => WebSocketLike;
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
    ws.addEventListener("close", () => this.handleClose());
    ws.addEventListener("error", () => {
      /* sự kiện close sẽ tới ngay sau đó */
    });
  }

  private handleOpen(): void {
    if (this.sessionId !== null) {
      this.send({
        op: GatewayOpcode.Resume,
        d: { token: this.options.token, sessionId: this.sessionId, seq: this.seq },
      });
    } else {
      this.send({
        op: GatewayOpcode.Identify,
        d: {
          token: this.options.token,
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

  private handleDispatch(payload: DispatchPayload): void {
    this.seq = payload.s;
    const { t, d } = payload;
    switch (t) {
      case "READY": {
        const data = d as GatewayEventMap["READY"];
        this.sessionId = data.sessionId;
        this.reconnectAttempt = 0;
        this.setState("ready");
        break;
      }
      case "RESUMED":
        this.reconnectAttempt = 0;
        this.setState("ready");
        break;
      default:
        break;
    }
    this.emit(t, d);
  }

  private emit<E extends GatewayEventName>(event: E, data: GatewayEventMap[E]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      (handler as EventHandler<E>)(data);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.awaitingHeartbeatAck = false;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

  private handleClose(): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.closedByUser) {
      this.setState("closed");
      return;
    }
    this.scheduleReconnect();
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
