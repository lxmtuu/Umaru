import net from "node:net";
import tls from "node:tls";
import { isBusMessage, type BusMessage, type EventBus } from "./bus.js";

/**
 * Bus Redis (pub/sub) — chạy khi `REDIS_URL` được đặt.
 *
 * **Vì sao tự viết client RESP thay vì thêm gói `redis`/`ioredis`:** ở đây chỉ
 * cần đúng hai lệnh (`PUBLISH`, `SUBSCRIBE`) và một kết nối sống lại khi đứt.
 * Gói chính thức kéo theo ~10 phụ thuộc, parser RESP3, cluster/Sentinel… mà
 * không dùng tới. Phần tự viết ở dưới có test với Redis **giả** nói RESP thật,
 * nên biết chắc phần khung dữ liệu chạy đúng; phần *hành vi server thật* thì phải
 * thử với Redis thật (ghi rõ trong DEPLOY.md).
 *
 * **Ai làm gì:** `SUBSCRIBE` chiếm riêng một kết nối (RESP2: đã subscribe thì
 * không chạy lệnh thường được nữa), còn `PUBLISH` dùng kết nối khác. Mất kết nối
 * subscribe thì tự nối lại và subscribe lại; message phát trong lúc đứt bị mất —
 * chấp nhận được vì client có `RESUME` + replay buffer riêng cho dữ liệu bền.
 */

export interface RedisTarget {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  db: number | null;
}

/** `redis://[:pass@]host:port[/db]`, `rediss://` = TLS. */
export function parseRedisUrl(raw: string): RedisTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`REDIS_URL không hợp lệ: ${raw}`);
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`REDIS_URL phải là redis:// hoặc rediss:// (nhận ${url.protocol})`);
  }
  const dbRaw = url.pathname.replace(/^\//, "");
  const db = dbRaw.length === 0 ? null : Number(dbRaw);
  if (db !== null && (!Number.isInteger(db) || db < 0)) {
    throw new Error(`REDIS_URL có số DB không hợp lệ: ${dbRaw}`);
  }
  return {
    host: url.hostname.length === 0 ? "127.0.0.1" : url.hostname,
    port: url.port.length === 0 ? 6379 : Number(url.port),
    secure: url.protocol === "rediss:",
    username: url.username.length === 0 ? null : decodeURIComponent(url.username),
    password: url.password.length === 0 ? null : decodeURIComponent(url.password),
    db,
  };
}

/** Mã hoá lệnh RESP dạng array bulk string (cách mọi client Redis nói). */
export function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }
  return out;
}

/**
 * Bộ đọc RESP **tăng dần**: nhận từng mẩu TCP, trả về các reply đã trọn vẹn.
 * Chưa đủ dữ liệu thì trả mảng rỗng và chờ mẩu sau — TCP không hứa một reply
 * nằm gọn trong một `data`.
 */
export class RespReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const parsed = this.readAt(0);
      if (parsed === null) break;
      this.buffer = this.buffer.subarray(parsed.next);
      out.push(parsed.value);
    }
    return out;
  }

  private readAt(offset: number): { value: unknown; next: number } | null {
    if (offset >= this.buffer.length) return null;
    const marker = String.fromCharCode(this.buffer[offset]!);
    const lineEnd = this.buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) return null;
    const line = this.buffer.subarray(offset + 1, lineEnd).toString("utf8");

    if (marker === "+") return { value: line, next: lineEnd + 2 };
    if (marker === "-") return { value: new Error(line), next: lineEnd + 2 };
    if (marker === ":") return { value: Number(line), next: lineEnd + 2 };

    if (marker === "$") {
      const length = Number(line);
      if (length < 0) return { value: null, next: lineEnd + 2 };
      const start = lineEnd + 2;
      const end = start + length;
      if (this.buffer.length < end + 2) return null;
      return { value: this.buffer.subarray(start, end).toString("utf8"), next: end + 2 };
    }

    if (marker === "*") {
      const count = Number(line);
      if (count < 0) return { value: null, next: lineEnd + 2 };
      const items: unknown[] = [];
      let cursor = lineEnd + 2;
      for (let index = 0; index < count; index += 1) {
        const item = this.readAt(cursor);
        if (item === null) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }

    throw new Error(`RESP: loại reply lạ "${marker}"`);
  }
}

export interface RedisBusOptions {
  url: string;
  /** Kênh pub/sub, mặc định `umaru:gateway`. */
  channel?: string;
  log?: (line: string) => void;
  /** Đồng hồ cho test (backoff cố định nhỏ). */
  reconnectDelayMs?: number;
}

const DEFAULT_CHANNEL = "umaru:gateway";
const MAX_QUEUED = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class RedisBus implements EventBus {
  private readonly target: RedisTarget;
  private readonly channel: string;
  private readonly log: (line: string) => void;
  private readonly reconnectDelayMs: number | null;
  private handler: ((message: BusMessage) => void) | null = null;

  private commandSocket: net.Socket | null = null;
  private subscribeSocket: net.Socket | null = null;
  private readonly reader = new RespReader();
  private queue: string[] = [];
  private closed = false;
  private backoffMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Đã gửi SUBSCRIBE thành công trên kết nối hiện tại chưa. */
  private subscribed = false;

  constructor(options: RedisBusOptions) {
    this.target = parseRedisUrl(options.url);
    this.channel = options.channel ?? DEFAULT_CHANNEL;
    this.log = options.log ?? (() => undefined);
    this.reconnectDelayMs = options.reconnectDelayMs ?? null;
  }

  publish(message: BusMessage): void {
    if (this.closed) return;
    const payload = JSON.stringify(message);
    const command = encodeCommand(["PUBLISH", this.channel, payload]);
    if (this.commandSocket === null) {
      // Chưa nối xong: giữ lại một ít rồi gửi bù. Bỏ message **cũ nhất** chứ
      // không bỏ message mới: cái mới là cái người dùng đang nhìn.
      if (this.queue.length >= MAX_QUEUED) this.queue.shift();
      this.queue.push(command);
      this.connectCommand();
      return;
    }
    this.commandSocket.write(command);
  }

  subscribe(handler: (message: BusMessage) => void): void {
    this.handler = handler;
    this.connectSubscribe();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.commandSocket?.destroy();
    this.subscribeSocket?.destroy();
    this.commandSocket = null;
    this.subscribeSocket = null;
  }

  /** Trạng thái cho `/health` hoặc log lúc khởi động. */
  getStatus(): { connected: boolean; subscribed: boolean; queued: number } {
    return {
      connected: this.commandSocket !== null && this.subscribeSocket !== null,
      subscribed: this.subscribed,
      queued: this.queue.length,
    };
  }

  // ---------- kết nối ----------

  private createSocket(): net.Socket {
    const socket = this.target.secure
      ? tls.connect({ host: this.target.host, port: this.target.port })
      : net.connect({ host: this.target.host, port: this.target.port });
    socket.setNoDelay(true);
    socket.on("error", (error: Error) => {
      this.log(`Redis: lỗi socket (${error.message})`);
    });
    return socket;
  }

  private handshake(socket: net.Socket): string {
    let out = "";
    if (this.target.password !== null) {
      out +=
        this.target.username === null
          ? encodeCommand(["AUTH", this.target.password])
          : encodeCommand(["AUTH", this.target.username, this.target.password]);
    }
    if (this.target.db !== null) out += encodeCommand(["SELECT", String(this.target.db)]);
    return out;
  }

  private connectCommand(): void {
    if (this.closed || this.commandSocket !== null) return;
    const socket = this.createSocket();
    this.commandSocket = socket;
    socket.on("connect", () => {
      socket.write(this.handshake(socket));
      // Gửi bù những message đã xếp hàng trong lúc chờ.
      const pending = this.queue;
      this.queue = [];
      for (const command of pending) socket.write(command);
      this.backoffMs = 1_000;
    });
    socket.on("close", () => {
      if (this.commandSocket === socket) this.commandSocket = null;
    });
  }

  private connectSubscribe(): void {
    if (this.closed || this.subscribeSocket !== null) return;
    const socket = this.createSocket();
    const reader = new RespReader();
    this.subscribeSocket = socket;
    socket.on("connect", () => {
      socket.write(this.handshake(socket));
      socket.write(encodeCommand(["SUBSCRIBE", this.channel]));
    });
    socket.on("data", (chunk: Buffer) => {
      let replies: unknown[];
      try {
        replies = reader.push(chunk);
      } catch (error) {
        this.log(`Redis: reply không đọc được (${(error as Error).message}) — nối lại`);
        socket.destroy();
        return;
      }
      for (const reply of replies) this.handleReply(reply);
    });
    socket.on("close", () => {
      if (this.subscribeSocket === socket) this.subscribeSocket = null;
      this.subscribed = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectCommand();
      this.connectSubscribe();
    }, this.reconnectDelayMs ?? this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private handleReply(reply: unknown): void {
    if (!Array.isArray(reply)) {
      // `+OK` của AUTH/SELECT, hoặc lỗi `-ERR …` (đã bọc thành Error).
      if (reply instanceof Error) this.log(`Redis: ${reply.message}`);
      return;
    }
    const kind = reply[0];
    if (kind === "subscribe") {
      this.subscribed = true;
      this.log(`Redis: đã subscribe kênh "${this.channel}"`);
      return;
    }
    if (kind !== "message") return;
    const payload = reply[2];
    if (typeof payload !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.log("Redis: message không phải JSON hợp lệ — bỏ qua");
      return;
    }
    if (!isBusMessage(parsed)) {
      this.log("Redis: message sai hình dạng — bỏ qua");
      return;
    }
    this.handler?.(parsed);
  }
}
