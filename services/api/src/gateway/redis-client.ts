import net from "node:net";
import tls from "node:tls";
import { encodeCommand, parseRedisUrl, RespReader, type RedisTarget } from "./redis-bus.js";

/**
 * Client Redis **có chờ trả lời** — dùng cho những lệnh cần kết quả (`HGETALL`,
 * `LRANGE`…), khác `RedisBus` chỉ đẩy sự kiện một chiều.
 *
 * Vì sao tách kết nối: RESP2 nói rằng một kết nối đã `SUBSCRIBE` thì chỉ nhận
 * message của kênh, không chạy lệnh thường được nữa. Bus giữ kết nối pub/sub,
 * store dùng kết nối lệnh riêng.
 *
 * Ghép reply với lệnh: Redis trả lời **đúng thứ tự** đã gửi, nên chỉ cần một
 * hàng đợi FIFO các promise. `pipeline()` gửi nhiều lệnh rồi chờ tất cả — 1 vòng
 * TCP thay vì N vòng, quan trọng vì mỗi sự kiện gateway ghi replay 3 lệnh.
 */

export type RedisReply = string | number | null | Error | RedisReply[];

export interface RedisClientOptions {
  url: string;
  log?: (line: string) => void;
  /** Thời gian chờ một reply trước khi coi như kết nối treo (ms). */
  replyTimeoutMs?: number;
}

const DEFAULT_REPLY_TIMEOUT_MS = 5_000;

interface PendingReply {
  resolve: (reply: RedisReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RedisClient {
  private readonly target: RedisTarget;
  private readonly log: (line: string) => void;
  private readonly replyTimeoutMs: number;

  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private reader = new RespReader();
  private readonly pending: PendingReply[] = [];
  private closed = false;

  constructor(options: RedisClientOptions) {
    this.target = parseRedisUrl(options.url);
    this.log = options.log ?? (() => undefined);
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  }

  async command(args: string[]): Promise<RedisReply> {
    const [reply] = await this.pipeline([args]);
    return reply ?? null;
  }

  /** Gửi nhiều lệnh trong một lượt, chờ đủ reply theo thứ tự. */
  async pipeline(commands: string[][]): Promise<RedisReply[]> {
    if (this.closed) throw new Error("RedisClient đã đóng");
    await this.ensureConnected();
    const replies = commands.map(() => this.register());
    this.socket!.write(commands.map((args) => encodeCommand(args)).join(""));
    return Promise.all(replies);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending(new Error("RedisClient đã đóng"));
    this.socket?.destroy();
    this.socket = null;
    this.connecting = null;
  }

  /** Đẩy một promise vào hàng đợi chờ reply (thứ tự = thứ tự lệnh gửi đi). */
  private register(): Promise<RedisReply> {
    return new Promise<RedisReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error("Redis không trả lời kịp"));
      }, this.replyTimeoutMs);
      timer.unref();
      this.pending.push({ resolve, reject, timer });
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.socket !== null) return Promise.resolve();
    if (this.connecting !== null) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.target.secure
        ? tls.connect({ host: this.target.host, port: this.target.port })
        : net.connect({ host: this.target.host, port: this.target.port });
      socket.setNoDelay(true);
      this.reader = new RespReader();

      const onConnectError = (error: Error): void => {
        this.log(`Redis (lệnh): ${error.message}`);
        socket.destroy();
        this.connecting = null;
        reject(error);
      };
      socket.once("error", onConnectError);
      socket.on("data", (chunk: Buffer) => {
        let replies: unknown[];
        try {
          replies = this.reader.push(chunk);
        } catch (error) {
          this.log(`Redis (lệnh): reply không đọc được (${(error as Error).message})`);
          socket.destroy();
          return;
        }
        for (const reply of replies) this.settle(reply);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        this.failPending(new Error("Kết nối Redis đã đóng"));
      });
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("error", (error: Error) => this.log(`Redis (lệnh): ${error.message}`));
        this.socket = socket;

        // AUTH/SELECT phải xong trước khi lệnh thật chạy: Redis xử lý tuần tự
        // trên một kết nối, nên chỉ cần chờ đủ reply của chúng.
        const handshake: string[][] = [];
        if (this.target.password !== null) {
          handshake.push(
            this.target.username === null
              ? ["AUTH", this.target.password]
              : ["AUTH", this.target.username, this.target.password],
          );
        }
        if (this.target.db !== null) handshake.push(["SELECT", String(this.target.db)]);
        if (handshake.length === 0) {
          resolve();
          return;
        }
        const replies = handshake.map(() => this.register());
        socket.write(handshake.map((args) => encodeCommand(args)).join(""));
        Promise.all(replies).then(
          () => resolve(),
          (error: Error) => reject(error),
        );
      });
    });
    return this.connecting;
  }

  private settle(reply: unknown): void {
    const entry = this.pending.shift();
    if (entry === undefined) {
      this.log("Redis (lệnh): reply thừa (không có lệnh chờ) — bỏ qua");
      return;
    }
    clearTimeout(entry.timer);
    if (reply instanceof Error) entry.reject(reply);
    else entry.resolve(reply as RedisReply);
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
