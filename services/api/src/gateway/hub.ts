import { randomBytes } from "node:crypto";
import {
  GatewayOpcode,
  GatewayVersion,
  type Channel,
  type DispatchPayload,
  type GatewayEventMap,
  type GatewayEventName,
  type GatewayReceivePayload,
  type PresenceEntry,
  type PresenceStatus,
  type Snowflake,
  type User,
  type VoiceState,
  type VoiceStateUpdate,
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
import type { ReplayFrame as StoredReplayFrame, SessionStore } from "./sessionStore.js";

/** Sự kiện không ghi vào replay log (spec §4.2). */
const TRANSIENT_EVENTS = new Set<GatewayEventName>(["TYPING_START", "PRESENCE_UPDATE", "RESUMED"]);

const IDENTIFY_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 1_048_576;
/** Giãn cách tối thiểu giữa hai lần IDENTIFY/RESUME trên cùng một socket (spec §7). */
const AUTH_COOLDOWN_MS = 5_000;
/** Số HEARTBEAT dư cho phép trong một interval — dư để chịu jitter, không phải để spam. */
const HEARTBEAT_SLACK = 2;
/**
 * Hạn ân hạn cho trạng thái thoại "mồ côi" (không còn session gateway nào).
 *
 * Cố tình **không** dùng `sessionTtlMs`: người dùng có thể join qua REST trước
 * khi socket identify xong, và trong test thì `sessionTtlMs` chỉ 5 giây — dọn
 * theo mốc đó sẽ xoá trạng thái vừa tạo. Ba mươi phút là đủ để không ai bị đá
 * oan, vẫn dọn được rác của người bỏ đi.
 */
const VOICE_STATE_ORPHAN_MS = 30 * 60 * 1000;

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
  /**
   * Nơi lưu session + replay log ngoài RAM (Redis). `null`/bỏ trống = chạy một
   * node, replay nằm trong bộ nhớ như trước (ADR-0006).
   */
  sessionStore?: SessionStore | null;
}

/** Một dòng presence mà node khác báo sang (hoặc node này báo đi). */
export interface PresenceState {
  userId: string;
  status: PresenceStatus;
  /** Guild của người đó **theo node nguồn**, để node nhận tự lọc người xem. */
  guildIds: string[];
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
  /**
   * Bạn bè (đã đồng ý) — presence được chia sẻ với bạn bè **kể cả khi không
   * chung server**, giống Discord: danh sách bạn bè phải hiện đúng chấm xanh.
   */
  friendIds: Set<string>;
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
  /**
   * Trạng thái người dùng **tự chọn** (idle / dnd / ẩn). Không có dòng nào =
   * "online" khi còn kết nối, "offline" khi hết. Không lưu DB: đây là trạng
   * thái sống, mất khi API restart — đúng như Discord (restart là về online).
   *
   * Một node thì Map là đủ; đa node phải chuyển sang Redis (cùng chỗ với replay
   * buffer, xem ADR-0003).
   */
  private readonly selectedStatus = new Map<string, PresenceStatus>();
  /**
   * Presence của người đang nối ở **node khác**, do bus báo sang.
   *
   * Chỉ để trả lời câu "ai đang online" cho `READY`/member list; trạng thái của
   * người nối ở node này luôn thắng (họ có session thật ở đây). Xoá dòng khi
   * nghe `offline`.
   */
  private readonly remotePresence = new Map<string, { status: PresenceStatus; guildIds: Set<string> }>();
  /** Do `ClusterPublisher` gắn vào khi chạy nhiều node; một node thì không có. */
  private presenceRelay: ((userId: string, status: PresenceStatus, guildIds: string[]) => void) | null = null;
  /**
   * Báo node khác "session này giờ của tao" khi resume ở node khác. Node cũ bỏ
   * session cục bộ và **không** phát offline (người dùng vẫn đang online).
   */
  private sessionRelay: ((sessionId: string) => void) | null = null;
  private readonly store: SessionStore | null;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly deps: HubDeps) {
    this.store = deps.sessionStore ?? null;
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  /**
   * Gắn đường phát presence sang node khác. Chỉ `ClusterPublisher` gọi; chế độ
   * một node không có relay nên không tốn gì.
   */
  setPresenceRelay(relay: (userId: string, status: PresenceStatus, guildIds: string[]) => void): void {
    this.presenceRelay = relay;
  }

  /** Gắn đường báo "session bị node khác đòi" (chỉ khi chạy nhiều node). */
  setSessionRelay(relay: (sessionId: string) => void): void {
    this.sessionRelay = relay;
  }

  /**
   * Node khác vừa resume session này → bỏ bản cục bộ, đóng socket cũ.
   *
   * **Không** phát `offline`: người dùng đang online ở node kia. Không xoá khoá
   * Redis: node mới vừa ghi đè `node` của chính nó vào đó.
   */
  dropClaimedSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.removalTimer !== null) {
      clearTimeout(session.removalTimer);
      session.removalTimer = null;
    }
    this.sessions.delete(sessionId);
    this.socketStates.forEach((otherState) => {
      if (otherState.session?.id === sessionId) otherState.session = null;
    });
    if (session.socket !== null) {
      this.close(session.socket, CLOSE.sessionGone, "Session đã được resume ở node khác");
    }
  }

  /** Presence mà node này biết (cục bộ + nghe được từ node khác). */
  localPresenceState(): PresenceState[] {
    const byUser = new Map<string, PresenceState>();
    for (const [userId, entry] of this.remotePresence) {
      byUser.set(userId, { userId, status: entry.status, guildIds: [...entry.guildIds] });
    }
    for (const session of this.sessions.values()) {
      if (session.socket === null) continue;
      byUser.set(String(session.userId), {
        userId: String(session.userId),
        status: this.presenceStatusFor(session.userId),
        guildIds: [...session.guildIds],
      });
    }
    return [...byUser.values()];
  }

  /**
   * Nhận trạng thái presence của một người từ node khác.
   *
   * Lọc tại đây chứ không tin node gửi: chỉ gửi tiếp cho session **có quan hệ**
   * với người đó (chung guild hoặc bạn bè). `offline` thì xoá khỏi bộ nhớ đệm.
   */
  deliverPresence(userId: string, status: PresenceStatus, guildIds: string[]): void {
    const id = String(userId);
    const local = [...this.sessions.values()].some(
      (session) => session.socket !== null && String(session.userId) === id,
    );
    if (status === "offline") this.remotePresence.delete(id);
    else if (!local) this.remotePresence.set(id, { status, guildIds: new Set(guildIds) });

    for (const target of this.sessions.values()) {
      if (target.socket === null) continue;
      const sameUser = String(target.userId) === id;
      if (!sameUser && !this.audienceMatches(target, id, guildIds)) continue;
      this.dispatch(target, "PRESENCE_UPDATE", { userId: id as Snowflake, status });
    }
  }

  /** Danh sách presence của node khác (khi có node mới tham gia) — áp + phát. */
  applyRemotePresence(entries: PresenceState[]): void {
    for (const entry of entries) {
      const id = String(entry.userId);
      const local = [...this.sessions.values()].some(
        (session) => session.socket !== null && String(session.userId) === id,
      );
      if (local) continue; // session thật ở đây thì trạng thái cục bộ mới đúng
      if (entry.status === "offline") {
        this.remotePresence.delete(id);
        continue;
      }
      this.remotePresence.set(id, { status: entry.status, guildIds: new Set(entry.guildIds) });
    }
    for (const entry of entries) {
      this.deliverPresence(entry.userId, entry.status, entry.guildIds);
    }
  }

  /** Session này có được thấy presence của `userId` không (chung guild / bạn bè). */
  private audienceMatches(session: Session, userId: string, guildIds: string[]): boolean {
    if (session.friendIds.has(userId)) return true;
    for (const guildId of guildIds) {
      if (session.guildIds.has(guildId)) return true;
    }
    return false;
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
      case GatewayOpcode.PresenceUpdate: {
        const session = state.session;
        if (session === null) return;
        this.handlePresenceUpdate(session, frame.d);
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
      friendIds: await this.loadFriendIds(userId),
      removalTimer: null,
    };
    this.sessions.set(session.id, session);
    state.session = session;
    if (state.identifyTimer !== null) {
      clearTimeout(state.identifyTimer);
      state.identifyTimer = null;
    }
    // Session phải có mặt trong store **trước** frame đầu tiên, nếu không frame
    // READY có thể được ghi vào một session mà không node nào tìm lại được.
    void this.persistSession(session);

    this.dispatch(session, "READY", {
      user: session.user,
      sessionId: session.id,
      guilds: bootstrap.guilds,
      dms: bootstrap.dms,
      readStates: bootstrap.readStates,
      channelPermissions: bootstrap.channelPermissions,
      voiceStates: bootstrap.voiceStates,
      // Thread đang mở (không nằm ở sidebar nên không đi kèm `guilds[].channels`).
      threads: bootstrap.threads,
      // Người đã online **trước khi mình vào** sẽ không có event PRESENCE_UPDATE
      // nào tới mình, nên snapshot này là thứ duy nhất cho biết ai đang ở đây.
      presences: this.presenceSnapshotFor(session),
    });
    // `presenceStatusFor` đã tính cả trạng thái tự chọn: người để "ẩn" thì
    // người khác vẫn phải thấy offline, không phải online.
    this.broadcastPresence(session, this.presenceStatusFor(session.userId));
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

    const local = this.sessions.get(sessionId);
    if (local === undefined) {
      // Session không nằm ở node này: có thể client vừa rơi vào node khác sau khi
      // mất mạng, hoặc node cũ đã restart. Nếu có store thì nhận lại từ đó.
      await this.resumeFromStore(socket, state, userId, sessionId, seq);
      return;
    }
    if (local.userId !== userId || (local.socket !== null && local.socket !== socket)) {
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }
    const session = local;

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
    // Trong lúc mất kết nối, người khác có thể đã đổi trạng thái mà replay
    // không chứa PRESENCE_UPDATE (event tạm thời, không phát lại) → gửi snapshot
    // để chấm online/offline không bị cũ sau khi nối lại.
    for (const entry of this.presenceSnapshotFor(session)) {
      this.dispatch(session, "PRESENCE_UPDATE", entry);
    }
    this.broadcastPresence(session, this.presenceStatusFor(session.userId));
  }

  /**
   * Resume một session **không** thuộc node này: dựng lại session từ store (DB là
   * nguồn sự thật cho quyền/guild, store chỉ giữ `seq` + replay), gửi những frame
   * client lỡ, rồi đòi quyền sở hữu.
   *
   * Đây là đường khiến "restart API" và "reconnect vào node khác" không còn làm
   * client phải full resync — đúng phần còn thiếu của ADR-0003.
   */
  private async resumeFromStore(
    socket: WebSocket,
    state: SocketState,
    userId: Snowflake,
    sessionId: string,
    seq: number,
  ): Promise<void> {
    if (this.store === null) {
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }
    const meta = await this.store.load(sessionId);
    if (meta === null || meta.userId !== String(userId)) {
      // Không tồn tại hoặc của người khác — cùng một câu trả lời, không tiết lộ
      // session id nào có thật.
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }

    const userResult = await this.deps.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    const userRow = userResult.rows[0];
    if (userRow === undefined) {
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }
    const bootstrap = await loadBootstrap(this.deps.pool, userId);
    const session: Session = {
      id: sessionId,
      userId,
      user: mapUser(userRow, "online"),
      socket,
      seq: meta.seq,
      replay: [],
      visibleChannels: bootstrap.visibleChannels,
      channelGuilds: channelGuildMap(bootstrap),
      guildIds: bootstrap.guildIds,
      friendIds: await this.loadFriendIds(userId),
      removalTimer: null,
    };
    this.sessions.set(sessionId, session);
    state.session = session;
    if (state.identifyTimer !== null) {
      clearTimeout(state.identifyTimer);
      state.identifyTimer = null;
    }

    // Đòi quyền sở hữu **trước** khi phát tiếp: node cũ phải ngừng ghi replay,
    // nếu không hai node cùng gán `s` cho một session.
    await this.store.claim(sessionId, this.deps.config.nodeId, this.deps.config.sessionTtlMs);
    this.sessionRelay?.(sessionId);
    if (meta.node !== "" && meta.node !== this.deps.config.nodeId) {
      this.deps.log?.(`[gateway] session ${sessionId} chuyển từ node ${meta.node} sang ${this.deps.config.nodeId}`);
    }

    const frames = await this.store.readReplay(sessionId, seq);
    // Server đã gán `s` mà replay không còn frame nào để bù (log bị cắt, hoặc
    // node cũ chết trước khi kịp ghi) → **không** giả vờ resume liền mạch.
    // Thà bắt client identify lại (full resync) còn hơn để họ mất tin mà không
    // biết. Đây là lý do `meta.seq` được ghi lúc ngắt kết nối.
    if (frames.length === 0 && meta.seq > seq) {
      this.deps.log?.(
        `[gateway] session ${sessionId} có khoảng trống replay (seq ${seq} → ${meta.seq}) — buộc identify lại`,
      );
      this.sessions.delete(sessionId);
      state.session = null;
      this.send(socket, { op: GatewayOpcode.InvalidSession, d: false });
      return;
    }
    // `seq` của session phải lớn hơn **mọi** `s` đã phát, kể cả `s` client đã
    // nhận trước khi ngắt: nếu không, frame RESUMED sẽ trùng số và client dedupe
    // theo `s` sẽ bỏ luôn frame đó.
    session.seq = Math.max(meta.seq, seq, ...frames.map((frame) => frame.s));
    for (const frame of frames) {
      this.send(socket, frame.payload as GatewayReceivePayload);
    }
    this.dispatch(session, "RESUMED", {});
    for (const entry of this.presenceSnapshotFor(session)) {
      this.dispatch(session, "PRESENCE_UPDATE", entry);
    }
    this.broadcastPresence(session, this.presenceStatusFor(session.userId));
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
    void this.persistSession(session, Date.now());
    session.removalTimer = setTimeout(() => {
      void this.store?.delete(session.id).catch((error: unknown) => {
        this.deps.log?.(`[gateway] không xoá được session ${session.id} khỏi store: ${String(error)}`);
      });
      this.sessions.delete(session.id);
      this.socketStates.forEach((otherState) => {
        if (otherState.session?.id === session.id) otherState.session = null;
      });
      // Hết session (đóng app / resume quá TTL) → ra khỏi phòng thoại, nếu không
      // sẽ có người "ngồi" trong kênh thoại mãi mãi dù không còn kết nối nào.
      // Chỉ khi **không còn session nào** của user, để đóng một tab không đá tab kia.
      if (!this.userHasConnectedSession(session.userId)) {
        void this.dropVoiceStates(session.userId);
      }
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
    this.deliverToChannel(channelId, event, data);
  }

  /**
   * Fan-out **chỉ trên node này**.
   *
   * `publishToChannel` gọi hàm này rồi (khi chạy nhiều node) đẩy tiếp qua bus;
   * node khác nhận bus cũng gọi đúng hàm này. Nhờ vậy điều kiện "ai được nhận"
   * (quyền xem kênh, không echo typing về người gõ) chỉ tồn tại ở **một** chỗ:
   * mỗi node tự lọc theo session của mình, không tin node gửi.
   */
  deliverToChannel<E extends GatewayEventName>(
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
    this.deliverToGuild(guildId, event, data);
  }

  /** Fan-out **chỉ trên node này** (xem `deliverToChannel`). */
  deliverToGuild<E extends GatewayEventName>(
    guildId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    for (const session of this.sessions.values()) {
      if (!session.guildIds.has(guildId)) continue;
      this.dispatch(session, event, data);
    }
  }

  publishVoiceState(channelId: string, data: VoiceStateUpdate): void {
    this.deliverVoiceState(channelId, data);
  }

  /** Fan-out **chỉ trên node này** (xem `deliverToChannel`). */
  deliverVoiceState(channelId: string, data: VoiceStateUpdate): void {
    for (const session of this.sessions.values()) {
      const involved = session.userId === data.userId;
      if (!involved && !session.visibleChannels.has(channelId)) continue;
      this.dispatch(session, "VOICE_STATE_UPDATE", data);
    }
  }

  publishToUser<E extends GatewayEventName>(
    userId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    this.deliverToUser(userId, event, data);
  }

  /** Fan-out **chỉ trên node này** (xem `deliverToChannel`). */
  deliverToUser<E extends GatewayEventName>(
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

  revokeChannelAccess(channelId: string, userIds: string[]): void {
    for (const session of this.sessions.values()) {
      if (!userIds.includes(session.userId)) continue;
      if (!session.visibleChannels.delete(channelId)) continue;
      this.dispatch(session, "CHANNEL_DELETE", {
        id: channelId as Channel["id"],
        guildId: null,
      });
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
   * Người này có **socket đang mở** không.
   *
   * Dùng cho thông báo đẩy: đang online thì không đẩy — họ đã nhận tin qua
   * WebSocket, và push qua dịch vụ của Google/Mozilla thường đến trễ, thành
   * thông báo "tin cũ" nhảy ra sau khi người ta đã đọc xong.
   *
   * Cố ý kiểm `socket !== null` chứ không chỉ "có trong `sessions`": session
   * được giữ lại sau khi socket đóng để client còn RESUME (`sessionTtlMs`).
   * Nếu tính cả những session đó thì người vừa đóng tab sẽ **không nhận push
   * của tin đầu tiên** — đúng lúc tính năng này cần nhất.
   */
  hasLiveSessionsFor(userId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.socket !== null) return true;
    }
    return false;
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

    // Mất quyền xem kênh thoại đang ngồi → phải bị đưa ra khỏi phòng. Kiểm ở
    // đây thay vì trong từng route quyền (role, overwrite, xoá kênh...) vì mọi
    // thay đổi quyền đều đi qua hàm này — một chỗ, không thể quên.
    const hidden = await this.deps.pool.query<{ channel_id: string }>(
      `SELECT channel_id FROM voice_states
        WHERE user_id = $1 AND channel_id <> ALL($2::bigint[])`,
      [userId, [...bootstrap.visibleChannels]],
    );
    if (hidden.rows.length > 0) {
      await this.dropVoiceStates(
        userId,
        hidden.rows.map((row) => row.channel_id),
      );
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
      // Đa node: cũng ghi vào store để node khác resume được. Một node thì
      // `store` là null — giữ nguyên đường cũ, không tốn gì.
      this.store?.appendReplay(
        session.id,
        session.seq,
        payload,
        this.deps.config.sessionTtlMs,
        this.deps.config.maxReplayEvents,
      );
    }
    if (session.socket !== null) this.send(session.socket, payload);
  }

  /**
   * Trạng thái hiện tại của một người: không có socket nào sống → offline; có
   * socket nhưng người dùng chọn "ẩn" → offline với người khác.
   */
  private presenceStatusFor(userId: Snowflake | string): PresenceStatus {
    const selected = this.selectedStatus.get(String(userId));
    if (selected === "offline") return "offline";
    if (!this.userHasConnectedSession(userId as Snowflake)) return "offline";
    return selected ?? "online";
  }

  /** Bạn bè đã đồng ý (hai dòng `friend` trong `relationships`). */
  private async loadFriendIds(userId: string): Promise<Set<string>> {
    const result = await this.deps.pool.query<{ friend_id: string }>(
      "SELECT target_id::text AS friend_id FROM relationships WHERE user_id = $1 AND type = 'friend'",
      [userId],
    );
    return new Set(result.rows.map((row) => row.friend_id));
  }

  /**
   * Nạp lại danh sách bạn bè và **phát bù** presence cho hai phía.
   *
   * Cần thiết vì phạm vi chia sẻ presence phụ thuộc quan hệ bạn bè: vừa kết bạn
   * xong mà không nạp lại thì hai người phải chờ tới lần kết nối sau mới thấy
   * trạng thái của nhau.
   */
  async refreshFriendAudience(userId: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter(
      (session) => String(session.userId) === String(userId),
    );
    if (sessions.length === 0) return;
    const friendIds = await this.loadFriendIds(userId);
    for (const session of sessions) {
      session.friendIds = friendIds;
      if (session.socket === null) continue;
      // Gửi snapshot mới cho chính mình, và báo trạng thái của mình cho người
      // vừa trở thành bạn (nếu họ đang kết nối).
      for (const entry of this.presenceSnapshotFor(session)) {
        this.dispatch(session, "PRESENCE_UPDATE", entry);
      }
      this.broadcastPresence(session, this.presenceStatusFor(session.userId));
    }
  }

  /** Presence có được chia sẻ giữa hai session: chung guild **hoặc** là bạn bè. */
  private sharesPresence(a: Session, b: Session): boolean {
    if (String(a.userId) === String(b.userId)) return false;
    for (const guildId of a.guildIds) {
      if (b.guildIds.has(guildId)) return true;
    }
    return a.friendIds.has(String(b.userId)) || b.friendIds.has(String(a.userId));
  }

  /** Người có chung ít nhất một guild với session này (không gồm chính họ). */
  private presenceSnapshotFor(session: Session): PresenceEntry[] {
    const byUser = new Map<string, PresenceEntry>();
    for (const other of this.sessions.values()) {
      if (other.socket === null) continue;
      if (String(other.userId) === String(session.userId)) continue;
      if (byUser.has(String(other.userId))) continue;
      if (!this.sharesPresence(session, other)) continue;
      byUser.set(String(other.userId), {
        userId: other.userId,
        status: this.presenceStatusFor(other.userId),
      });
    }
    // Người nối ở node khác: chỉ thêm khi node này không có session của chính họ
    // (có session thật thì trạng thái cục bộ đúng hơn).
    for (const [userId, entry] of this.remotePresence) {
      if (byUser.has(userId)) continue;
      if (!this.audienceMatches(session, userId, [...entry.guildIds])) continue;
      byUser.set(userId, { userId: userId as Snowflake, status: entry.status });
    }
    return [...byUser.values()];
  }

  /**
   * Người dùng bấm đổi trạng thái. Ghi nhớ rồi phát cho mọi session có chung
   * guild — **kể cả session khác của chính họ** (mở hai máy phải đồng bộ), chỉ
   * bỏ qua đúng socket vừa gửi để không dội lại chính nó.
   */
  private handlePresenceUpdate(session: Session, data: unknown): void {
    const status = (data as { status?: unknown } | null)?.status;
    if (status !== "online" && status !== "idle" && status !== "dnd" && status !== "offline") {
      // Frame rác: bỏ qua, không đóng — đổi trạng thái không phải lỗi giao thức.
      return;
    }
    const key = String(session.userId);
    if (status === "online") this.selectedStatus.delete(key);
    else this.selectedStatus.set(key, status);
    this.broadcastPresence(session, this.presenceStatusFor(session.userId), session.id);
  }

  private broadcastPresence(session: Session, status: PresenceStatus, skipSessionId?: string): void {
    // Node khác phải biết: session của người xem có thể đang nằm ở đó. Relay nhận
    // `guildIds` để node kia tự lọc người xem theo quan hệ.
    this.presenceRelay?.(String(session.userId), status, [...session.guildIds]);
    const targets = new Map<string, Session>();
    for (const other of this.sessions.values()) {
      if (other.socket === null) continue;
      if (skipSessionId !== undefined && other.id === skipSessionId) continue;
      // Trạng thái của **chính mình** chỉ cần phát cho thiết bị khác của mình
      // khi mình vừa chủ động đổi (`skipSessionId` có giá trị). Lúc kết nối thì
      // bỏ qua: họ vừa vào, tự biết mình online.
      const sameUser = String(other.userId) === String(session.userId);
      if (sameUser && skipSessionId === undefined) continue;
      // Cùng người (thiết bị khác) luôn nhận; người khác thì phải chung server
      // hoặc là bạn bè.
      if (sameUser || this.sharesPresence(session, other)) targets.set(other.id, other);
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

  /**
   * Xoá trạng thái thoại của user và phát `VOICE_STATE_UPDATE` (channelId null)
   * cho từng phòng họ đang ở. Dùng khi hết session hoặc mất quyền xem kênh.
   */
  async dropVoiceStates(userId: string, onlyChannelIds?: string[]): Promise<void> {
    const result = await this.deps.pool.query<{ guild_id: string; channel_id: string }>(
      onlyChannelIds === undefined
        ? "DELETE FROM voice_states WHERE user_id = $1 RETURNING guild_id, channel_id"
        : "DELETE FROM voice_states WHERE user_id = $1 AND channel_id = ANY($2::bigint[])"
          + " RETURNING guild_id, channel_id",
      onlyChannelIds === undefined ? [userId] : [userId, onlyChannelIds],
    );
    for (const row of result.rows) {
      this.publishVoiceState(row.channel_id, {
        guildId: row.guild_id as Snowflake,
        channelId: null,
        userId: userId as Snowflake,
        selfMute: false,
        selfDeaf: false,
        joinedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Dọn trạng thái thoại "mồ côi": người dùng không còn session gateway nào
   * (đóng app, hoặc join qua REST rồi biến mất) nhưng vẫn nằm trong phòng.
   *
   * Có thời gian ân hạn vì mất mạng tạm thời vẫn giữ session để resume — chỉ
   * dọn những dòng cũ hơn hạn đó, và **không** dọn người đang có session.
   */
  private async sweepVoiceStates(): Promise<void> {
    const connected = [...new Set([...this.sessions.values()].map((session) => session.userId))];
    const result = await this.deps.pool.query<{ guild_id: string; channel_id: string; user_id: string }>(
      `DELETE FROM voice_states
        WHERE user_id <> ALL($1::bigint[])
          AND joined_at < now() - ($2::text || ' milliseconds')::interval
        RETURNING guild_id, channel_id, user_id`,
      [connected, String(VOICE_STATE_ORPHAN_MS)],
    );
    for (const row of result.rows) {
      this.publishVoiceState(row.channel_id, {
        guildId: row.guild_id as Snowflake,
        channelId: null,
        userId: row.user_id as Snowflake,
        selfMute: false,
        selfDeaf: false,
        joinedAt: new Date().toISOString(),
      });
    }
  }

  /** Ghi metadata session (userId/seq/node) + gia hạn TTL trong store. */
  private async persistSession(session: Session, disconnectedAt: number | null = null): Promise<void> {
    if (this.store === null) return;
    try {
      await this.store.save(
        {
          id: session.id,
          userId: String(session.userId),
          seq: session.seq,
          node: this.deps.config.nodeId,
          disconnectedAt,
        },
        this.deps.config.sessionTtlMs,
      );
    } catch (error) {
      this.deps.log?.(`[gateway] không ghi được session ${session.id}: ${String(error)}`);
    }
  }

  private sweep(): void {
    void this.sweepVoiceStates().catch((error: unknown) => {
      this.deps.log?.(`[gateway] dọn voice_states lỗi: ${String(error)}`);
    });
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
