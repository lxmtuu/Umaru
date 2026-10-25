import type {
  Channel,
  Guild,
  GuildMember,
  Message,
  PresenceStatus,
  ReadState,
  Role,
  User,
} from "./api.js";
import type { Snowflake } from "./snowflake.js";

export const GatewayVersion = 1;

export const GatewayOpcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export type GatewayOpcode = (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

// —— client → server ——

export interface HeartbeatPayload {
  op: 1;
  d: number | null;
}

export interface IdentifyPayload {
  op: 2;
  d: {
    token: string;
    properties: { os: string; browser: string; device: string };
  };
}

export interface ResumePayload {
  op: 6;
  d: { token: string; sessionId: string; seq: number };
}

export type GatewaySendPayload = HeartbeatPayload | IdentifyPayload | ResumePayload;

// —— server → client ——

export interface HelloPayload {
  op: 10;
  d: { heartbeat_interval: number };
}

export interface HeartbeatServerPayload {
  op: 1;
  d: null;
}

export interface ReconnectPayload {
  op: 7;
  d: null;
}

export interface InvalidSessionPayload {
  op: 9;
  d: boolean; // true = có thể resume, false = phải identify lại
}

export interface HeartbeatAckPayload {
  op: 11;
  d: null;
}

export interface DispatchPayload<E extends GatewayEventName = GatewayEventName> {
  op: 0;
  t: E;
  s: number; // sequence number mới nhất
  d: GatewayEventMap[E];
}

export type GatewayReceivePayload =
  | DispatchPayload
  | HelloPayload
  | HeartbeatServerPayload
  | ReconnectPayload
  | InvalidSessionPayload
  | HeartbeatAckPayload;

// —— sự kiện server → client ——

/** Thông tin tối thiểu để render tên/avatar thành viên trong tin nhắn. */
export interface GuildMemberSummary {
  userId: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Role đang mang, KHÔNG gồm @everyone (mặc định ai cũng có). */
  roleIds: Snowflake[];
}

/** Snapshot guild gửi kèm READY để client dựng sidebar ngay, không cần N request. */
export interface GuildSnapshot {
  guild: Guild;
  channels: Channel[];
  /** Toàn bộ role của server, sắp theo `position` giảm dần (mạnh nhất trước). */
  roles: Role[];
  members: GuildMemberSummary[];
}

/** DM 1-1: channel không thuộc guild nào + thông tin người ở đầu bên kia. */
export interface DmChannelSummary {
  channel: Channel;
  recipient: GuildMemberSummary;
}

export type GatewayEventName = keyof GatewayEventMap;

export interface GatewayEventMap {
  READY: {
    user: User;
    sessionId: string;
    guilds: GuildSnapshot[];
    dms: DmChannelSummary[];
    readStates: ReadState[];
    /**
     * Quyền **hiệu dụng của chính user này** tại từng kênh nhìn thấy được
     * (channelId → bitfield dạng chuỗi thập phân, parse bằng `parsePermissions`).
     * Server tính sẵn bằng `resolvePermissions` nên client chỉ việc đọc: ẩn/hiện
     * nút mà không phải chép lại thuật toán, và không bao giờ lệch với REST.
     * Kênh tạo sau khi READY chưa có trong map (xem lại sau khi reconnect).
     */
    channelPermissions: Record<Snowflake, string>;
  };
  RESUMED: Record<string, never>;
  /**
   * Quyền hiệu dụng của user vừa thay đổi (gán/thu role, đổi overwrite, kênh
   * mới, vừa vào server). Gửi **toàn bộ** map cho session của chính user đó nên
   * client chỉ cần thay thế, không phải tính diff — và không ảnh hưởng user khác.
   */
  PERMISSIONS_UPDATE: { channelPermissions: Record<Snowflake, string> };
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: {
    id: Snowflake;
    channelId: Snowflake;
    content: string | null;
    editedAt: string | null;
  };
  MESSAGE_DELETE: { id: Snowflake; channelId: Snowflake };
  TYPING_START: { channelId: Snowflake; userId: Snowflake; timestamp: number };
  PRESENCE_UPDATE: { userId: Snowflake; status: PresenceStatus };
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: { id: Snowflake; guildId: Snowflake | null };
  GUILD_CREATE: {
    guild: Guild;
    channels: Channel[];
    roles: Role[];
    members: GuildMember[];
  };
  GUILD_MEMBER_ADD: { guildId: Snowflake; member: GuildMemberSummary };
  /**
   * Thứ thuộc về thành viên vừa đổi (hiện tại: role được gán/thu). Gửi kèm
   * summary đầy đủ để client chỉ việc thay thế, không phải tự ghép diff.
   */
  GUILD_MEMBER_UPDATE: { guildId: Snowflake; member: GuildMemberSummary };
  /** Role được tạo/sửa — client cập nhật bảng roles cục bộ; quyền thật vẫn do `PERMISSIONS_UPDATE` đẩy riêng cho từng user. */
  ROLE_CREATE: { guildId: Snowflake; role: Role };
  ROLE_UPDATE: { guildId: Snowflake; role: Role };
  /** `member_roles` cascade theo FK nên client tự coi như đã gán cho ai. */
  ROLE_DELETE: { guildId: Snowflake; roleId: Snowflake };
  /** DM mới được mở — `recipient` là người ở đầu bên kia (khác nhau theo phía nhận). */
  DM_CHANNEL_CREATE: DmChannelSummary;
  VOICE_STATE_UPDATE: {
    guildId: Snowflake | null;
    channelId: Snowflake | null;
    userId: Snowflake;
    sessionId: string;
    muted: boolean;
    deafened: boolean;
    speaking: boolean;
  };
}
