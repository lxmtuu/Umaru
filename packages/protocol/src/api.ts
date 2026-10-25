import type { Snowflake } from "./snowflake.js";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface User {
  id: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: PresenceStatus;
  /** Đã xác thực email chưa (client hiện nhắc khi còn `false`). */
  emailVerified: boolean;
  createdAt: string; // ISO-8601
}

export type ChannelType = "guild_text" | "guild_voice" | "category" | "dm" | "group_dm";

export interface Guild {
  id: Snowflake;
  name: string;
  iconUrl: string | null;
  ownerId: Snowflake;
  createdAt: string;
}

export interface Channel {
  id: Snowflake;
  guildId: Snowflake | null; // null = DM / group DM
  type: ChannelType;
  name: string | null; // null trong DM
  topic: string | null;
  categoryId: Snowflake | null;
  position: number;
}

export interface Role {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  color: number; // 0xRRGGBB
  position: number; // càng cao càng mạnh
  permissions: string; // bitfield thập phân (JSON-safe) — parse bằng parsePermissions()
  /** Đúng 1 role `@everyone` mỗi server — client không cho xoá/gán role này. */
  isEveryone: boolean;
}

/**
 * Ghi đè quyền tại một kênh cho một role hoặc thành viên.
 * `allow`/`deny` là bitfield dạng chuỗi thập phân; giao nhau luôn rỗng.
 */
export interface ChannelOverwrite {
  channelId: Snowflake;
  targetType: "role" | "member";
  targetId: Snowflake;
  /** Tên role, hoặc display name của thành viên. */
  targetName: string;
  /** Target là role `@everyone` — áp cho mọi thành viên chưa bị ghi đè riêng. */
  isEveryone: boolean;
  /** Màu role (0 với target là thành viên). */
  color: number;
  allow: string;
  deny: string;
}

export interface GuildMember {
  guildId: Snowflake;
  userId: Snowflake;
  roleIds: Snowflake[];
  nickname: string | null;
  joinedAt: string;
}

export interface Attachment {
  id: Snowflake;
  filename: string;
  url: string;
  size: number; // bytes
  mimeType: string;
  width: number | null;
  height: number | null;
}

/**
 * Trạng thái đã đọc của một kênh.
 * `unread` = số tin người khác gửi sau mốc đã đọc;
 * `mentions` = số tin trong đó có @gọi tên mình (badge đỏ, tính riêng).
 */
export interface ReadState {
  channelId: Snowflake;
  lastReadMessageId: Snowflake;
  unread: number;
  mentions: number;
}

export interface Message {
  id: Snowflake;
  channelId: Snowflake;
  authorId: Snowflake;
  content: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: Snowflake | null;
  attachments: Attachment[];
  pinned: boolean;
}

/** Thông tin tối thiểu để render tên/avatar người gửi trong danh sách mention. */
export interface UserSummary {
  userId: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Một dòng trong tab Mentions: tin nhắn có @gọi mình kèm kênh để nhảy tới.
 * `recipient` chỉ có khi kênh là DM (người ở đầu bên kia).
 */
export interface MessageMention {
  message: Message;
  channel: Channel;
  /** Tên server (null nếu là DM) — hiển thị trong dòng "trong #kênh · Server". */
  guildName: string | null;
  author: UserSummary;
  recipient: UserSummary | null;
}

/**
 * Một dòng kết quả tìm kiếm tin nhắn.
 *
 * Cùng hình dạng với `MessageMention` (kèm kênh + tên server + người gửi) để
 * client dùng lại được phần render danh sách; `recipient` chỉ có ở kênh DM.
 * `message.content` là nội dung đầy đủ — client tự cắt/tô sáng theo từ khoá.
 */
export interface MessageSearchHit {
  message: Message;
  channel: Channel;
  guildName: string | null;
  author: UserSummary;
  recipient: UserSummary | null;
}
