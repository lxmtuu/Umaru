import type {
  Channel,
  FriendRequestSummary,
  FriendSummary,
  Guild,
  GuildMember,
  Message,
  PresenceStatus,
  ReadState,
  Role,
  User,
  UserProfile,
  UserSettings,
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
  /** DM 1-1: người bên kia. Group DM: `null` (xem `recipients`). */
  recipient: GuildMemberSummary | null;
  /** Mọi người khác trong cuộc, không gồm chính mình (1-1: đúng 1 phần tử). */
  recipients: GuildMemberSummary[];
  /** Chủ nhóm — chỉ group DM mới có; người tạo lúc đầu. */
  ownerId: Snowflake | null;
  /** Tên nhóm do người dùng đặt; `null` = hiển thị bằng cách ghép tên thành viên. */
  name: string | null;
  /**
   * `true` = DM này đang là **yêu cầu chờ duyệt** do chính mình gửi (người kia
   * đặt `dm_privacy = 'friends'`). Chỉ người gửi thấy cờ này — người nhận không
   * có kênh trong danh sách cho tới khi họ đồng ý (xem `MessageRequestSummary`).
   */
  requestPending: boolean;
}

/**
 * Một yêu cầu nhắn tin đang chờ **mình** duyệt: người lạ đã mở DM, mình chưa
 * đồng ý nên kênh không nằm trong danh sách DM bình thường.
 */
export interface MessageRequestSummary {
  channelId: Snowflake;
  /** Người đã mở cuộc trò chuyện. */
  sender: UserProfile;
  createdAt: string;
  /** Nội dung tin mới nhất (cắt 200 ký tự) — đủ để quyết định, không tải cả lịch sử. */
  preview: string | null;
  messageCount: number;
}

/** Số người tối đa trong group DM (tính cả mình) — giống Discord. */
export const MAX_GROUP_DM_MEMBERS = 10;

/**
 * Trạng thái một người trong kênh thoại (G2, chưa có SFU).
 *
 * Cố tình **không** có `speaking`: trạng thái đó chỉ có nghĩa khi có audio thật
 * và đổi liên tục; khi cắm LiveKit vào thì nó đi qua data channel của SFU, không
 * qua gateway.
 */
export interface VoiceState {
  guildId: Snowflake;
  channelId: Snowflake;
  userId: Snowflake;
  selfMute: boolean;
  selfDeaf: boolean;
  joinedAt: string;
}

/**
 * `VOICE_STATE_UPDATE` dùng **cùng shape** với `VoiceState` để client chỉ cần
 * một mapper; `channelId: null` = người đó đã rời phòng (client xoá khỏi danh
 * sách mọi phòng của guild đó).
 */
export type VoiceStateUpdate = Omit<VoiceState, "channelId"> & { channelId: Snowflake | null };

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
    /**
     * Ai đang ở phòng thoại nào trong các guild user **xem được** (đã lọc quyền
     * qua `visibleChannels`) — đúng theo tiêu chí "permission leak" ở §8.
     */
    voiceStates: VoiceState[];
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
  /**
   * Ghim/bỏ ghim. Tách khỏi `MESSAGE_UPDATE` vì sửa nội dung và ghim là hai
   * thao tác khác quyền nhau (sửa: tác giả; ghim: `MANAGE_MESSAGES`), và client
   * cần phân biệt để chỉ cập nhật đúng trường `pinned`.
   */
  MESSAGE_PIN_UPDATE: { id: Snowflake; channelId: Snowflake; pinned: boolean };
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
  /**
   * Hồ sơ người dùng đổi (hiện tại: avatar). Gửi tới mọi server mà người đó là
   * thành viên và tới các session của chính họ. Client chỉ cập nhật
   * username/displayName/avatarUrl — trạng thái online vẫn do `PRESENCE_UPDATE` quản.
   */
  USER_UPDATE: { user: UserProfile };
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
  /** Tên nhóm hoặc danh sách thành viên đổi → gửi lại toàn bộ summary. */
  DM_CHANNEL_UPDATE: DmChannelSummary;
  /** Bị mời ra khỏi nhóm (hoặc nhóm bị xoá) → client bỏ khỏi sidebar. */
  DM_CHANNEL_DELETE: { channelId: Snowflake };
  MESSAGE_REQUEST_CREATE: MessageRequestSummary;
  /** Đã xử lý xong (đồng ý, từ chối, kết bạn, chặn) → bỏ khỏi danh sách chờ. */
  MESSAGE_REQUEST_REMOVE: { channelId: Snowflake };
  VOICE_STATE_UPDATE: VoiceStateUpdate;
  /** Có người gửi lời mời kết bạn cho mình (kèm người gửi để vẽ ngay). */
  FRIEND_REQUEST_CREATE: FriendRequestSummary;
  /** Hai người đã thành bạn — gửi cho **cả hai** để danh sách hai bên khớp. */
  FRIEND_ADD: FriendSummary;
  /** Hết bạn (tự huỷ kết bạn, từ chối lời mời, huỷ lời mời đã gửi, hoặc bị chặn). */
  FRIEND_REMOVE: { userId: Snowflake };
  /** Cài đặt riêng của chính mình vừa đổi — gửi cho mọi session của mình. */
  USER_SETTINGS_UPDATE: UserSettings;
}
