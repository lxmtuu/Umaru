import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import type { GatewayHub } from "../src/gateway/hub.js";
import { loadConfig, type Config } from "../src/config.js";
import { createPool, migrate, truncateAll, type Pool } from "../src/db.js";
import { MemoryMailer } from "../src/mail.js";
import type { ReportNotifier } from "../src/admin/notify.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://umaru:umaru@127.0.0.1:55432/umaru_test";

export interface TestContext {
  app: FastifyInstance;
  hub: GatewayHub;
  pool: Pool;
  config: Config;
  /** Thư mục upload riêng cho từng lần chạy test (xoá khi close). */
  uploadsDir: string;
  /** Hộp thư trong bộ nhớ — test khẳng định mail xác thực đã gửi. */
  mailer: MemoryMailer;
  /** Mail báo admin khi có báo cáo mới — `await whenIdle()` để chờ gửi xong. */
  reportNotifier: ReportNotifier;
  close(): Promise<void>;
}

export async function createTestContext(
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<TestContext> {
  const uploadsDir = await mkdtemp(path.join(tmpdir(), "umaru-uploads-"));
  const config: Config = {
    ...loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: "test-secret-not-for-production",
      HEARTBEAT_INTERVAL_MS: "5000",
      SESSION_TTL_MS: "5000",
      ACCESS_TOKEN_TTL_SEC: "900",
      UPLOADS_DIR: uploadsDir,
      ...envOverrides,
    }),
    logger: false,
  };
  const pool = createPool(config.databaseUrl, { max: 5 });
  await migrate(pool, config.migrationsDir);
  await truncateAll(pool);
  const mailer = new MemoryMailer();
  const { app, hub, reportNotifier } = await buildApp({ config, pool, mailer });
  return {
    app,
    hub,
    pool,
    config,
    uploadsDir,
    mailer,
    reportNotifier,
    async close() {
      await app.close();
      await pool.end();
      await rm(uploadsDir, { recursive: true, force: true });
    },
  };
}

export interface RegisteredUser {
  id: string;
  username: string;
  token: string;
  refreshToken: string;
}

export async function registerUser(
  ctx: TestContext,
  username: string,
  password = "mat-khau-123",
): Promise<RegisteredUser> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username,
      displayName: username,
      email: `${username}@example.com`,
      password,
      // Đăng ký luôn phải đồng ý điều khoản; test nào cố tình bỏ sẽ tự gửi tay.
      acceptedTerms: true,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Đăng ký thất bại: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ user: { id: string }; accessToken: string; refreshToken: string }>();
  return {
    id: body.user.id,
    username,
    token: body.accessToken,
    refreshToken: body.refreshToken,
  };
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function createGuild(ctx: TestContext, token: string, name = "Umaru Dev"): Promise<string> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/guilds",
    headers: auth(token),
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Tạo guild lỗi: ${response.body}`);
  return response.json<{ id: string }>().id;
}

export async function listChannels(
  ctx: TestContext,
  token: string,
  guildId: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(token),
  });
  if (response.statusCode !== 200) throw new Error(`List channel lỗi: ${response.body}`);
  return response.json();
}

export async function sendMessage(
  ctx: TestContext,
  token: string,
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(token),
    payload: { content },
  });
  if (response.statusCode !== 201) throw new Error(`Gửi tin lỗi: ${response.body}`);
  return response.json();
}

export interface Frame {
  op: number;
  t?: string;
  s?: number;
  d?: unknown;
}

/** Client WS tối giản: đợi frame theo loại dispatch, giữ lại frame chưa dùng. */
export class GatewayTestClient {
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  closeCode: number | null = null;
  lastSeq = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (typeof frame.s === "number" && frame.s > this.lastSeq) this.lastSeq = frame.s;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(frame);
        return;
      }
      this.queue.push(frame);
    });
    socket.on("close", (code) => {
      this.closeCode = code;
    });
    socket.on("error", () => {
      /* lỗi kết nối sẽ được phản ánh qua close code */
    });
  }

  static async connect(url: string): Promise<{ client: GatewayTestClient; hello: Frame }> {
    const socket = new WebSocket(url);
    const client = new GatewayTestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const hello = await client.next((frame) => frame.op === 10);
    return { client, hello };
  }

  get raw(): WebSocket {
    return this.socket;
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  async next(predicate: (frame: Frame) => boolean, timeoutMs = 3_000): Promise<Frame> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [frame] = this.queue.splice(queuedIndex, 1);
      return frame!;
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Hết thời gian chờ frame gateway"));
      }, timeoutMs);
      const wrapped = (frame: Frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  async dispatch<T = unknown>(event: string, timeoutMs = 3_000): Promise<T> {
    const frame = await this.next((f) => f.op === 0 && f.t === event, timeoutMs);
    return frame.d as T;
  }

  /** Không nhận được event trong khoảng thời gian cho trước. */
  async expectNoDispatch(event: string, waitMs = 400): Promise<void> {
    try {
      await this.dispatch(event, waitMs);
    } catch {
      return;
    }
    throw new Error(`Không mong đợi event ${event} nhưng vẫn nhận được`);
  }

  /** Đợi socket đóng và trả close code. */
  async waitClose(timeoutMs = 3_000): Promise<number | null> {
    if (this.closeCode !== null) return this.closeCode;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket không đóng đúng hạn")), timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closeCode;
  }

  close(): void {
    this.socket.close();
  }
}
