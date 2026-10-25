import { randomBytes } from "node:crypto";
import {
  GatewayOpcode,
  GatewayVersion,
  type Channel,
  type DispatchPayload,
  type GatewayEventMap,
  type GatewayEventName,
  type GatewayReceivePayload,
  type Snowflake,
  type User,
} from "@umaru/protocol";
import type { RawData, WebSocket } from "ws";
import { loadBootstrap } from "../bootstrap.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import type { TokenService } from "../auth/tokens.js";
import type { UserRow } from "../mappers.js";
import { mapUser } from "../mappers.js";
import { Bucket } from "../rateLimit.js";

/** Sự kiện không ghi vào replay log (spec §4.2). */
const TRANSIENT_EVENTS = new Set<GatewayEventName>(["TYPING_START", "PRESENCE_UPDATE", "RESUMED"]);

const IDENTIFY_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 1_048_576;
/** Giãn cách tối thiểu giữa hai lần IDENTIFY/RESUME trên cùng một socket (spec §7). */
const AUTH_COOLDOWN_MS = 5_000;
/** Số HEARTBEAT dư cho phép trong một interval — dư để chịu jitter, không phải để spam. */
const HEARTBEAT_SLACK = 2;

/** Mã đóng theo spec §2.1 — đặt tên để chỗ dùng không phải nhớ số. */
const CLOSE = {
  authFailed: 4000,
  heartbeatsTimeout: 4001,
  invalidPayload: 4002,
  sessionGone: 4003,
  rateLimited: 4004,
  slowConsumer: 4008,
} as const;

export interface HubDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  /** Ghi log cảnh báo (heartbeat dư bị bỏ, đóng session…) — app truyền logger vào. */
  log?: (line: string) => void;
}

interface ReplayFrame {
  s: number;
  payload: DispatchPayload;
}

interface Session {
  id: string;
  userId: Snowflake;
  user: User;
  socket: WebSocket | null;
  seq: number;
  replay: ReplayFrame[];
  visibleChannels: Set<string>;
  /** channelId → guildId, để biết gửi CHANNEL_DELETE cho guild nào. */
  channelGuilds: Map<string, string>;
  guildIds: Set<string>;
  removalTimer: NodeJS.Timeout | null;
}

interface SocketState {
  session: Session | null;
  identifyTimer: NodeJS.Timeout | null;
  lastSeenAt: number;
  closed: boolean;
  /**
   * Lần IDENTIFY / lần RESUME gần nhất — mỗi loại 1 lần/5s/socket (spec §7).
   *
   * Đếm **riêng hai loại** vì giao thức cho phép `INVALID_SESSION` giữ kết nối
   * rồi client identify lại ngay (§2.1): nếu gộp chung một bộ đếm thì luồng hợp
   * lệ đó bị đóng 4004, đúng thứ đã xảy ra với một test có sẵn.
   */
  lastIdentifyAt: number;
  lastResumeAt: number;
  /** 120 frame/phút/socket (spec §7); vượt → đóng 4004. */
  frames: Bucket;
  /** HEARTBEAT: 1/interval + 2 dư; vượt → bỏ qua và log, **không** đóng. */
  heartbeats: Bucket;
  /** Số HEARTBEAT bị bỏ liên tiếp — chỉ log lần đầu, tránh bão log thành DoS. */
  heartbeatDrops: number;
}

/**
 * Gateway một node (G1). Giao thức: docs/gateway-protocol.md.
 * Resume dùng replay buffer trong bộ nhớ — đủ cho một node; đa node phải thay
 * bằng Redis Streams (ADR-0003), phần còn lại của logic không đổi.
 */
export class GatewayHub implements EventPublisher {
  private readonly sessions = new Map<string, Session>();
  private readonly socketStates = new Map<WebSocket, SocketState>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly deps: HubDeps) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  // ---------- vòng đời socket ----------

  attach(socket: WebSocket): void {
    const identifyTimer = setTimeout(() => {
      if (state.session === null) this.close(socket, CLOSE.heartbeatsTimeout, "Identify timeout");
    }, IDENTIFY_TIMEOUT_MS);
    identifyTimer.unref();
    const interval = this.deps.config.heartbeatIntervalMs;
    const state: SocketState = {
      session: null,
      identifyTimer,
      lastSeenAt: Date.now(),
      closed: false,
      lastIdentifyAt: 0,
      lastResumeAt: 0,
      frames: new Bucket(this.deps.config.rateLimitGatewayFramesPerMinute, 60_000),
      heartbeats: new Bucket(1 + HEARTBEAT_SLACK, interval),
      heartbeatDrops: 0,
    };
    this.socketStates.set(socket, state);
    this.send(socket, { op: GatewayOpcode.Hello, d: { heartbeat_interval: this.deps.config.heartbeatIntervalMs } });

    socket.on("message", (raw: RawData) => {
      state.lastSeenAt = Date.now();
      void this.handleMessage(socket, state, raw);
    });
    socket.on("close", () => this.handleSocketClose(socket, state));
    socket.on("error", () => {
      /* close sẽ tới ngay sau đó */
    });
  }

  private async handleMessage(socket: WebSocket, state: SocketState, raw: RawData): Promise<void> {
    // Đếm **mọi** frame client → server (kể cả frame rác) trước khi parse: chặn
    // flood ngay từ đầu, không để kẻ tấn công ép server parse JSON liên tục.
    if (this.deps.config.rateLimitsEnabled && state.frames.take() !== null) {
      this.close(socket, CLOSE.rateLimited, "Gửi quá nhiều frame");
      return;
    }

    let frame: { op: number; d?: unknown };
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not object");
      frame = parsed as { op: number; d?: unknown };
    } catch {
      this.close(socket, CLOSE.invalidPayload, "Payload không phải JSON hợp lệ");
      return;
    }
    if (typeof frame.op !== "number") {
      this.close(socket, CLOSE.invalidPayload, "Thiếu opcode");
      return;
    }

    switch (frame.op) {
      case GatewayOpcode.Heartbeat: {
        state.lastSeenAt = Date.now();
        // Spec §7: dư 2 frame/interval thì bỏ qua và log, không đóng — client gửi
        // heartbeat dày thường do jitter, đóng sẽ gây reconnect loop vô ích.
        if (this.deps.config.rateLimitsEnabled && state.heartbeats.take() !== null) {
          state.heartbeatDrops += 1;
          // Chỉ log lần đầu của chuỗi: một socket flood 120 frame/phút mà log từng
          // frame thì chính log là kênh tấn công.
          if (state.heartbeatDrops === 1) {
            this.deps.log?.(`[gateway] bỏ qua HEARTBEAT dư (userId=${state.session?.userId ?? "?"})`);
          }
          return;
        }
        state.heartbeatDrops = 0;
        this.send(socket, { op: GatewayOpcode.HeartbeatAck, d: null });
        return;
      }
      case GatewayOpcode.Identify:
        await this.handleIdentify(socket, state, frame.d);
        return;
      case GatewayOpcode.Resume:
        await this.handleResume(socket, state, frame.d);
        return;
      default:
        this.close(socket, CLOSE.invalidPayload, `Opcode client không hỗ trợ: ${frame.op}`);
    }
  }

  /**
   * Chặn spam IDENTIFY/RESUME trên cùng socket (spec §7: 1 lần/5s).
   *
   * Đếm cả lần thất bại: thử token sai liên tục cũng là tấn công, và hợp lệ thì
   * client chỉ cần identify một lần cho mỗi kết nối.
   */
  private allowAuthAttempt(state: SocketState, kind: "identify" | "resume"): boolean {
    if (!this.deps.config.rateLimitsEnabled) return true;
    const now = Date.now();
    const last = kind === "identify" ? state.lastIdentifyAt : state.lastResumeAt;
    const allowed = now - last >= AUTH_COOLDOWN_MS;
    if (kind === "identify") state.lastIdentifyAt = now;
    else state.lastResumeAt = now;
    return allowed;
  }

  private async handleIdentify(socket: WebSocket, state: SocketState, data: unknown): Promise<void> {
    if (state.session !== null) {
      this.close(socket, CLOSE.invalidPayload, "Đã identify trên kết nối này");
      return;
    }
    if (!this.allowAuthAttempt(state, "identify")) {
      this.close(socket, CLOSE.rateLimited, "IDENTIFY quá nhanh");
      return;
    }
    const token = readToken(data);
    if (token === null) {
      this.close(socket, CLOSE.authFailed, "Thiếu token");
      return;
    }
    const userId = await this.verifyToken(token);
    if (userId === null) {
      this.close(socket, CLOSE.authFailed, "Token không hợp lệ");
      return;
    }

    const userResult = await this.deps.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    const userRow = userResult.rows[0];
    if (userRow === undefined) {
      this.close(socket, CLOSE.authFailed, "Tài khoản không tồn tại");
      return;
    }

    // Trần session/user (spec §7): đóng session **cũ nhất** rồi mới mở session mới,
    // để client mất mạng rồi mở lại nhiều lần không tích session vô hạn.
    const limit = this.deps.config.rateLimitSessionsPerUser;
    if (this.deps.config.rateLimitsEnabled && limit > 0) {
      const sameUser = [...this.sessions.values()].filter(
        (item) => item.userId === userId && item.socket !== null && item.socket !== socket,
      );
      const excess = sameUser.length - (limit - 1);
      for (const oldest of sameUser.slice(0, Math.max(0, excess))) {
        this.deps.log?.(`[gateway] đóng session cũ ${oldest.id} của ${userId} (quá ${limit} session)`);
        if (oldest.socket !== null) {
          this.close(oldest.socket, CLOSE.sessionGone, "Quá số session cho phép");
        }
      }
    }

    const bootstrap = await loadBootstrap(this.deps.pool, userId);
    const session: Session = {
      id: randomBytes(16).toString("base64url"),
      userId,
      user: mapUser(userRow, "online"),
      socket,
      seq: 0,
      replay: [],
      visibleChannels: bootstrap.visibleChannels,
      channelGuilds: channelGuildMap(bootstrap),
      guildIds: bootstrap.guildIds,
      removalTimer: null,
    };
    this.sessions.set(session.id, session);
    state.session = session;
    if (state.identifyTimer !== null) {
      clearTimeout(state.identifyTimer);
      state.identifyTimer = null;
    }

    this.dispatch(session, "READY", {
      user: session.user,
      sessionId: session.id,
      guilds: bootstrap.guilds,
      dms: bootstrap.dms,
      readStates: bootstrap.readStates,
      channelPermissions: bootstrap.channelPermissions,
    });
    this.broadcastPresence(session, "online");
  }

  private async handleResume(socket: WebSocket, state: SocketState, data: unknown): Promise<void> {
    if (!this.allowAuthAttempt(state, "resume")) {
      this.close(socket, CLOSE.rateLimited, "RESUME quá nhanh");
      return;
    }
    const token = readToken(data);
    const sessionId = readStringField(data, "sessionId");
    const seq = readNumberField(data, "seq");
    if (token === null || sessionId === null || seq === null) {
      this.close(socket, CLOSE.invalidPayload, "RESUME thiếu token/sessionId/seq");
      return;
    }
    const userId = await this.verifyToken(token);
    if (userId === null) {
      this.close(socket, CLOSE.authFailed, "Token không hợp lệ");
      return;
    }

    const session = this.sessions.get(sessionId);
    if (
      session === undefined ||
      session.userId !== userId ||
      (session.socket !== null && session.socket !== socket)
    ) {
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }

    if (session.removalTimer !== null) {
      clearTimeout(session.removalTimer);
      session.removalTimer = null;
    }
    session.socket = socket;
    state.session = session;
    if (state.identifyTimer !== null) {
      clearTimeout(state.identifyTimer);
      state.identifyTimer = null;
    }

    const missed = session.replay.filter((frame) => frame.s > seq);
    for (const frame of missed) this.send(socket, frame.payload);
    this.dispatch(session, "RESUMED", {});
    this.broadcastPresence(session, "online");
  }

  private handleSocketClose(socket: WebSocket, state: SocketState): void {
    state.closed = true;
    if (state.identifyTimer !== null) {
      clearTimeout(state.identifyTimer);
      state.identifyTimer = null;
    }
    this.socketStates.delete(socket);

    const session = state.session;
    if (session === null || session.socket !== socket) return;
    session.socket = null;
    session.replay = session.replay.slice(-this.deps.config.maxReplayEvents);
    session.removalTimer = setTimeout(() => {
      this.sessions.delete(session.id);
      this.socketStates.forEach((otherState) => {
        if (otherState.session?.id === session.id) otherState.session = null;
      });
    }, this.deps.config.sessionTtlMs);
    session.removalTimer.unref();

    if (!this.userHasConnectedSession(session.userId)) {
      this.broadcastPresence(session, "offline");
    }
  }

  // ---------- phát sự kiện ----------

  publishToChannel<E extends GatewayEventName>(
    channelId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    for (const session of this.sessions.values()) {
      // Session đang offline vẫn phải ghi replay log — đó là cơ chế resume.
      if (!session.visibleChannels.has(channelId)) continue;
      // Typing không echo về chính người gõ (spec §5.1).
      if (event === "TYPING_START") {
        const payload = data as GatewayEventMap["TYPING_START"];
        if (payload.userId === session.userId) continue;
      }
      this.dispatch(session, event, data);
    }
  }

  publishToGuild<E extends GatewayEventName>(
    guildId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    for (const session of this.sessions.values()) {
      if (!session.guildIds.has(guildId)) continue;
      this.dispatch(session, event, data);
    }
  }

  publishToUser<E extends GatewayEventName>(
    userId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      this.dispatch(session, event, data);
    }
  }

  grantChannelAccess(channelId: string, userIds: string[]): void {
    for (const session of this.sessions.values()) {
      if (!userIds.includes(session.userId)) continue;
      session.visibleChannels.add(channelId);
    }
  }

  async refreshGuildVisibility(guildId: string): Promise<void> {
    const userIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.guildIds.has(guildId)) userIds.add(session.userId);
    }
    for (const userId of userIds) {
      await this.refreshUserVisibility(userId);
    }
  }

  /**
   * Đồng bộ lại guild + kênh mà session được thấy. Cần gọi sau khi user tạo
   * guild hoặc join invite: READY đã chạy trước đó nên session chưa biết guild mới.
   */
  async refreshUserVisibility(userId: string): Promise<void> {
    const targets = [...this.sessions.values()].filter((session) => session.userId === userId);
    if (targets.length === 0) return;

    const bootstrap = await loadBootstrap(this.deps.pool, userId as Snowflake);
    const channelGuilds = channelGuildMap(bootstrap);
    for (const session of targets) {
      // Ảnh chụp danh sách kênh client đang biết (gồm cả category) trước khi cập nhật.
      const knownChannels = new Set(session.channelGuilds.keys());
      for (const previous of session.visibleChannels) {
        if (bootstrap.visibleChannels.has(previous)) continue;
        const guildId = session.channelGuilds.get(previous) ?? null;
        session.visibleChannels.delete(previous);
        // Mất quyền xem → client xoá kênh, giống hành vi Discord.
        this.dispatch(session, "CHANNEL_DELETE", {
          id: previous as Channel["id"],
          guildId: guildId as Channel["guildId"],
        });
      }
      session.guildIds = bootstrap.guildIds;
      session.channelGuilds = channelGuilds;
      session.visibleChannels = new Set(bootstrap.visibleChannels);
      // Vừa được xem kênh (overwrite mới, vừa vào server...) → client phải thấy
      // ngay trong sidebar, không cần reconnect. Category không nằm trong
      // visibleChannels nhưng vẫn có trong channelGuilds nên được gửi cùng.
      for (const snapshot of bootstrap.guilds) {
        for (const channel of snapshot.channels) {
          if (knownChannels.has(channel.id)) continue;
          this.dispatch(session, "CHANNEL_CREATE", channel);
        }
      }
      // READY đã qua từ lâu → đẩy lại quyền để client bật/tắt nút mà không phải reconnect.
      this.dispatch(session, "PERMISSIONS_UPDATE", {
        channelPermissions: bootstrap.channelPermissions,
      });
    }
  }

  // ---------- nội bộ ----------

  private dispatch<E extends GatewayEventName>(
    session: Session,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    session.seq += 1;
    const payload: DispatchPayload = {
      op: GatewayOpcode.Dispatch,
      t: event,
      s: session.seq,
      d: data as GatewayEventMap[GatewayEventName],
    };
    if (!TRANSIENT_EVENTS.has(event)) {
      session.replay.push({ s: session.seq, payload });
      if (session.replay.length > this.deps.config.maxReplayEvents) {
        session.replay.splice(0, session.replay.length - this.deps.config.maxReplayEvents);
      }
    }
    if (session.socket !== null) this.send(session.socket, payload);
  }

  private broadcastPresence(session: Session, status: "online" | "offline"): void {
    const targets = new Map<string, Session>();
    for (const other of this.sessions.values()) {
      if (other.socket === null) continue;
      if (other.userId === session.userId) continue;
      let sharesGuild = false;
      for (const guildId of session.guildIds) {
        if (other.guildIds.has(guildId)) {
          sharesGuild = true;
          break;
        }
      }
      if (sharesGuild) targets.set(other.id, other);
    }
    for (const target of targets.values()) {
      this.dispatch(target, "PRESENCE_UPDATE", { userId: session.userId, status });
    }
  }

  private userHasConnectedSession(userId: Snowflake): boolean {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.socket !== null) return true;
    }
    return false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [socket, state] of this.socketStates) {
      if (state.session === null) continue;
      if (now - state.lastSeenAt > this.deps.config.heartbeatIntervalMs * 2) {
        this.close(socket, CLOSE.heartbeatsTimeout, "Heartbeat timeout");
      }
    }
  }

  private async verifyToken(token: string): Promise<Snowflake | null> {
    try {
      const { userId } = await this.deps.tokens.verifyAccessToken(token);
      return userId;
    } catch {
      return null;
    }
  }

  private send(socket: WebSocket, payload: GatewayReceivePayload | { op: number; d: unknown }): void {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(socket, CLOSE.slowConsumer, "Slow consumer");
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === 1 || socket.readyState === 0) socket.close(code, reason);
  }

  getStats(): { sessions: number; connected: number; version: number } {
    let connected = 0;
    for (const session of this.sessions.values()) if (session.socket !== null) connected += 1;
    return { sessions: this.sessions.size, connected, version: GatewayVersion };
  }
}

function channelGuildMap(bootstrap: Awaited<ReturnType<typeof loadBootstrap>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const snapshot of bootstrap.guilds) {
    for (const channel of snapshot.channels) map.set(channel.id, snapshot.guild.id);
  }
  return map;
}

function readToken(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const token = (data as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function readStringField(data: unknown, field: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumberField(data: unknown, field: string): number | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
