import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { gatewayCompressionOptions } from "./gateway/compression.js";
import Fastify, { type FastifyInstance } from "fastify";
import { hasAnyAdminConfigured } from "./admin/access.js";
import { ReportNotifier } from "./admin/notify.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTotpRoutes } from "./auth/totp-routes.js";
import { registerThreadRoutes } from "./threads/routes.js";
import { createMailer, type Mailer } from "./mail.js";
import { createTokenService, type TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";
import { registerDmRequestRoutes } from "./dms/requests.js";
import { registerDmRoutes } from "./dms/routes.js";
import { registerFriendRoutes } from "./friends/routes.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { GatewayHub } from "./gateway/hub.js";
import { ClusterPublisher } from "./gateway/cluster.js";
import { RedisBus } from "./gateway/redis-bus.js";
import { RedisClient } from "./gateway/redis-client.js";
import { RedisSessionStore } from "./gateway/redis-session-store.js";
import type { SessionStore } from "./gateway/sessionStore.js";
import type { EventBus } from "./gateway/bus.js";
import type { EventPublisher } from "./events.js";
import { registerGuildRoutes } from "./guilds/routes.js";
import { badRequest, registerErrorHandler } from "./http.js";
import { registerMessageRoutes } from "./messages/routes.js";
import { registerOverwriteRoutes } from "./overwrites/routes.js";
import { registerPushRoutes } from "./push/routes.js";
import { PushSender } from "./push/sender.js";
import { registerReadStateRoutes } from "./read-states/routes.js";
import { registerSafetyRoutes } from "./safety/routes.js";
import { registerSearchRoutes } from "./search/routes.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import { registerUserRoutes } from "./users/routes.js";
import { registerVoiceRoutes } from "./voice/routes.js";
import { MAX_FILES_PER_MESSAGE, createStores } from "./uploads/storage.js";
import { LinkEmbedResolver } from "./embeds/resolver.js";
import type { FetchHtmlOptions } from "./embeds/fetch.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  /** Thay bằng hộp thư trong bộ nhớ khi test; mặc định suy ra từ `config.smtpUrl`. */
  mailer?: Mailer;
  /**
   * Thay bằng transport giả khi test thông báo đẩy. `undefined` = dùng web-push
   * thật (chỉ hoạt động khi đã cấu hình VAPID), `null` = tắt push.
   */
  pushTransport?: import("./push/sender.js").PushTransport | null;
  /**
   * Bus giữa các node — bơm vào khi test nhiều node. `undefined` = tự dựng theo
   * `config.redisUrl` (không có thì chạy một node, fan-out trong bộ nhớ).
   */
  bus?: EventBus;
  /**
   * Store session/replay (Redis) — bơm vào khi test. `undefined` = tự dựng theo
   * `config.redisUrl` (không có thì replay nằm trong RAM).
   */
  sessionStore?: SessionStore;
  /**
   * Thay hàm tải trang khi test embed (test dựng HTTP server thật trên
   * 127.0.0.1 nên thường không cần). `undefined` = tải thật có hàng rào SSRF.
   */
  embedFetch?: (url: string, options: FetchHtmlOptions) => Promise<{ html: string; finalUrl: string }>;
  /** Bỏ qua để tự dựng theo `config.embeds`; `null` = tắt hẳn embed. */
  embeds?: LinkEmbedResolver | null;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: GatewayHub;
  tokens: TokenService;
  mailer: Mailer;
  /** Mail báo admin khi có báo cáo mới (test chờ `whenIdle()`). */
  reportNotifier: ReportNotifier;
  /** Thông báo đẩy khi tab đóng (test chờ `whenIdle()`, hoặc bơm transport giả). */
  pushSender: PushSender;
  /** Lớp phát sự kiện route dùng: chính `hub` khi một node, hoặc bọc bus. */
  publisher: EventPublisher;
  /** Bus liên node (`null` khi chạy một node) — `close()` khi tắt app. */
  bus: EventBus | null;
  /** Store session/replay (`null` khi replay nằm trong RAM). */
  sessionStore: SessionStore | null;
  /** Bộ dựng embed liên kết (`null` khi `EMBEDS=off`) — test chờ `whenIdle()`. */
  embeds: LinkEmbedResolver | null;
  /** Tên node trong bus — mỗi tiến trình một tên. */
  nodeId: string;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config, pool } = deps;
  const app = Fastify({
    logger: config.logger ? { level: "info" } : false,
    bodyLimit: 1024 * 1024,
    // Chỉ tin `X-Forwarded-*` khi có proxy thật (`TRUST_PROXY=1`): rate limit
    // và log địa chỉ đều dựa vào `request.ip`, sai nguồn là sai hết.
    trustProxy: config.trustProxy,
  });

  await app.register(websocket, {
    options: {
      maxPayload: 4 * 1024, // spec §1: frame ≤ 4 KiB (tính trên dữ liệu đã giải nén)
      // Nén frame lớn (`READY`, `MESSAGE_CREATE`…). Tắt bằng `GATEWAY_COMPRESS=off`.
      perMessageDeflate: gatewayCompressionOptions(config),
    },
  });
  // Upload file đi qua multipart; trần cứng đặt ở đây để Fastify chặn trước
  // khi ghi đĩa (route vẫn kiểm lại MIME và số file).
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: MAX_FILES_PER_MESSAGE,
      fields: 10,
      parts: 20,
    },
  });
  registerErrorHandler(app);

  const tokens = createTokenService(config.jwtSecret, config.accessTokenTtlSec);
  // Kho tệp: đĩa cục bộ hoặc S3/R2 tuỳ `STORAGE_DRIVER`. Dựng **một lần** ở đây
  // rồi truyền xuống route — dựng theo từng request là tạo client mới mỗi lần.
  const storage = createStores(config);
  if (config.logger) {
    app.log.info(
      storage.driver === "s3"
        ? `Kho tệp: S3 (bucket ${config.storage?.bucket ?? "?"})`
        : `Kho tệp: đĩa cục bộ (${config.uploadsDir})`,
    );
  }
  // Chưa có SMTP_URL → ghi mail ra log để dev tự bấm link (xem mail.ts).
  const mailer = deps.mailer ?? createMailer(config, (line) => app.log.info(line));
  const logLine = (line: string): void => app.log.warn(line);
  const nodeId = config.nodeId;
  // Store session/replay: chỉ bật khi có Redis, để chạy một node vẫn không cần
  // hạ tầng gì thêm.
  const redisClient =
    config.redisUrl === null || deps.sessionStore !== undefined
      ? null
      : new RedisClient({ url: config.redisUrl, log: logLine });
  const sessionStore: SessionStore | null =
    deps.sessionStore ?? (redisClient === null ? null : new RedisSessionStore(redisClient));
  const hub = new GatewayHub({
    pool,
    config,
    tokens,
    sessionStore,
    log: (line) => app.log.warn(line),
  });
  // Một node: route phát thẳng qua hub (không tốn thêm lớp nào). Nhiều node:
  // fan-out tại chỗ **rồi** đẩy lên bus, và nhận bus của node khác để fan-out.
  const bus: EventBus | null =
    deps.bus ?? (config.redisUrl === null ? null : new RedisBus({ url: config.redisUrl, channel: config.redisChannel, log: logLine }));
  const publisher: EventPublisher =
    bus === null ? hub : new ClusterPublisher(hub, bus, nodeId, logLine);
  if (bus !== null) {
    app.log.info(
      `Gateway: chế độ nhiều node, bus=${bus.constructor.name}, session=${sessionStore === null ? "RAM" : sessionStore.constructor.name}, node=${nodeId}`,
    );
  }

  /**
   * Xem trước liên kết: dựng **một** hàng đợi cho cả tiến trình (trần đồng
   * thời + cache URL dùng chung, xem `embeds/resolver.ts`). Tắt bằng `EMBEDS=off`
   * khi máy chủ không được gọi ra ngoài.
   */
  const embeds: LinkEmbedResolver | null =
    deps.embeds === null
      ? null
      : (deps.embeds ??
        (config.embeds.enabled
          ? new LinkEmbedResolver(
              { pool, publisher, config: config.embeds },
              deps.embedFetch === undefined ? {} : { fetch: deps.embedFetch },
            )
          : null));
  // Push: chỉ gửi khi đã cấu hình VAPID; `transport` bơm được từ `deps` để test
  // kiểm nội dung gửi đi mà không cần mạng ra dịch vụ push.
  const pushSender = new PushSender({
    pool,
    config,
    hub,
    transport: deps.pushTransport,
    write: (line) => app.log.warn(line),
  });
  const reportNotifier = new ReportNotifier({
    pool,
    config,
    mailer,
    write: (line) => app.log.warn(line),
  });

  /**
   * Tham số đường dẫn dạng id (`:channelId`, `:messageId`, `:memberId`...) đi
   * thẳng vào câu SQL `WHERE id = $1` với cột BIGINT. Không kiểm trước thì
   * `GET /channels/abc/messages` làm PostgreSQL ném `22P02` → 500 kèm log lỗi
   * hệ thống, trong khi đúng phải là 400 (client gửi sai). Kiểm một lần ở đây
   * thay vì lặp lại trong từng route.
   */
  app.addHook("preValidation", async (request) => {
    const params = request.params;
    if (typeof params !== "object" || params === null) return;
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (!/Id$/.test(key) || typeof value !== "string") continue;
      if (!/^\d{1,20}$/.test(value)) {
        throw badRequest(`"${key}" phải là snowflake (chuỗi số)`);
      }
    }
  });

  // `/health` cũng cho biết node nào và đang chạy chế độ một node hay nhiều node:
  // khi debug "người ở node A không nhận tin" thì đây là chỗ nhìn đầu tiên.
  app.get("/health", async () => ({
    ok: true,
    ...hub.getStats(),
    node: nodeId,
    bus: bus === null ? "local" : bus.constructor.name,
    sessionStore: sessionStore === null ? "memory" : sessionStore.constructor.name,
  }));

  await app.register(
    async (api) => {
      registerAuthRoutes(api, { pool, tokens, config, mailer });
      registerTotpRoutes(api, { pool, config, tokens });
      registerGuildRoutes(api, { pool, config, tokens, publisher });
      registerMessageRoutes(api, {
        pool,
        config,
        tokens,
        publisher,
        push: pushSender,
        storage,
        embeds: embeds ?? undefined,
      });
      registerThreadRoutes(api, { pool, config, tokens, publisher });
      registerOverwriteRoutes(api, { pool, config, tokens, publisher });
      registerDmRoutes(api, { pool, config, tokens, publisher, storage });
      registerDmRequestRoutes(api, { pool, config, tokens, publisher, storage });
      registerReadStateRoutes(api, { pool, tokens, publisher });
      registerSearchRoutes(api, { pool, tokens });
      registerSafetyRoutes(api, { pool, tokens, config, reportNotifier, publisher });
      registerAdminRoutes(api, { pool, tokens, config });
      registerUploadRoutes(api, { pool, config, tokens , storage });
      registerUserRoutes(api, { pool, config, tokens, publisher, storage });
      registerVoiceRoutes(api, { pool, config, tokens, publisher });
      registerPushRoutes(api, { pool, config, tokens, sender: pushSender });
      registerFriendRoutes(api, {
        pool,
        tokens,
        publisher,
        // Đi qua `publisher` (không phải `hub`) để node khác cũng tính lại.
        refreshPresence: (userId) => publisher.refreshFriendAudience(userId),
      });
      registerGatewayRoutes(api, hub, tokens, config);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    embeds?.close();
    hub.dispose();
    await bus?.close();
    await sessionStore?.close();
  });

  // Cảnh báo cấu hình thiếu: báo cáo vẫn được ghi nhưng không ai đọc được.
  if (!hasAnyAdminConfigured(config)) {
    app.log.warn(
      "Chưa đặt ADMIN_USER_IDS/ADMIN_USERNAMES — hàng đợi báo cáo (/admin/reports) không ai truy cập được",
    );
  }

  return {
    app,
    hub,
    tokens,
    mailer,
    reportNotifier,
    pushSender,
    publisher,
    bus,
    sessionStore,
    embeds,
    nodeId,
  };
}
