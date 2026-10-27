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
  /** Giới thiệu ngắn (≤ 190 ký tự). `null` = chưa đặt. */
  bio?: string | null;
  /** Đại từ tuỳ chọn (`they/them`, `cô ấy`…) ≤ 40 ký tự. */
  pronouns?: string | null;
  /** Màu banner `#rrggbb`; `null` = dùng màu mặc định. */
  bannerColor?: string | null;
}

/**
 * Phần hồ sơ công khai của một người, dùng cho sự kiện `USER_UPDATE`.
 * Không kèm `status` vì presence là trạng thái ephemeral, đi qua `PRESENCE_UPDATE`.
 */
export interface UserProfile {
  id: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio?: string | null;
  pronouns?: string | null;
  bannerColor?: string | null;
}

/**
 * Hồ sơ một người **khác** nhìn thấy được (`GET /users/:id/profile`).
 *
 * Chỉ trả khi hai người có liên hệ (chung server, đã kết bạn, hoặc đang có DM) —
 * hồ sơ là thông tin tự nguyện chia sẻ, không phải danh bạ toàn hệ thống.
 */
export interface PublicProfile {
  id: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  pronouns: string | null;
  bannerColor: string | null;
  createdAt: string;
}

/**
 * Ai được mở DM với mình.
 *
 * - `everyone`: ai biết username cũng mở được (mặc định — giữ nguyên hành vi cũ).
 * - `friends`: chỉ người đã kết bạn. Người lạ nhận **403** kèm lý do, không phải
 *   404: che giấu sự tồn tại của tài khoản không phải mục tiêu (username vốn
 *   công khai), còn nói rõ lý do giúp người ta biết phải kết bạn trước.
 */
export type DmPrivacy = "everyone" | "friends";

export interface UserSettings {
  dmPrivacy: DmPrivacy;
}

export interface FriendSummary {
  user: UserProfile;
  /** Thời điểm hai người thành bạn (ISO-8601) — danh sách sắp mới nhất trước. */
  since: string;
}

export interface FriendRequestSummary {
  user: UserProfile;
  createdAt: string;
}

/**
 * Toàn bộ trạng thái quan hệ của **chính mình** trong một lần gọi: client vẽ
 * được cả ba tab (bạn bè / lời mời tới / lời mời đã gửi) mà không phải ghép
 * nhiều endpoint.
 */
export interface FriendList {
  dmPrivacy: DmPrivacy;
  friends: FriendSummary[];
  /** Người khác gửi lời mời cho mình. */
  incoming: FriendRequestSummary[];
  /** Mình đã gửi, đang chờ người kia đồng ý. */
  outgoing: FriendRequestSummary[];
}

export type ChannelType =
  | "guild_text"
  | "guild_voice"
  | "category"
  | "dm"
  | "group_dm"
  /** Luồng con của một kênh text — **không** hiện trên sidebar. */
  | "guild_thread";

/**
 * Thread (luồng thảo luận) của một kênh text.
 *
 * `id` **là** một channel id: mọi API tin nhắn/reaction/ghim/tìm kiếm dùng thẳng
 * nó. Client chỉ cần thêm một dòng vào bảng kênh khi mở panel thread.
 */
export interface ThreadSummary {
  id: Snowflake;
  parentChannelId: Snowflake;
  /** Tin gốc sinh ra thread; null khi thread tạo tay. */
  rootMessageId: Snowflake | null;
  name: string;
  ownerId: Snowflake | null;
  /** Số tin trong thread (không tính tin gốc ở kênh cha). */
  messageCount: number;
  createdAt: string;
  /** Lần cuối có tin mới — dùng để sắp xếp và tự lưu trữ. */
  lastActivityAt: string;
  archived: boolean;
}

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
  /**
   * Slowmode của kênh, tính bằng giây (0 = tắt).
   *
   * Chỉ áp cho **người thường**: ai có `MANAGE_MESSAGES`/`MANAGE_CHANNELS` vẫn
   * gửi liên tục được (Discord cũng vậy — người trực kênh cần nói nhiều).
   */
  slowmodeSeconds: number;
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
 * Một sticker đã sẵn sàng hiển thị.
 *
 * `imageUrl` trỏ endpoint có xác thực (`/guilds/:guildId/stickers/:id/image`),
 * client tải bằng fetch + Bearer rồi dựng blob URL — cùng lý do với avatar:
 * token không nằm trong `<img src>`.
 */
export interface Sticker {
  id: Snowflake;
  packId: Snowflake;
  name: string;
  imageUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Gói sticker của một server. */
export interface StickerPack {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  createdBy: Snowflake;
  stickers: Sticker[];
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

/**
 * Reaction đã gộp theo emoji.
 *
 * `me` tính **theo người xem**: hai client nhận cùng một tin nhưng `me` khác
 * nhau. Vì vậy response của REST luôn tính theo người gọi, còn event realtime chỉ
 * mang delta (`emoji`, `count`, `userId`, `added`) để mỗi client tự suy ra `me` —
 * xem `MESSAGE_REACTION_UPDATE`.
 */
export interface ReactionSummary {
  emoji: string;
  /** Số người đã thả emoji này. Không bao giờ là 0 (0 thì reaction bị bỏ). */
  count: number;
  /** Người đang xem đã thả emoji này chưa. */
  me: boolean;
}

/**
 * Thẻ xem trước liên kết (kiểu embed của Discord) cho URL đầu tiên trong tin.
 *
 * Server tải trang một lần rồi lưu lại; client **không** gọi ra ngoài để lấy nội
 * dung này. Mọi trường phụ đều có thể null — trang thật thiếu thẻ đủ kiểu, và
 * một embed chỉ có tên miền vẫn tốt hơn không có gì.
 */
export interface Embed {
  /** URL gốc trong nội dung tin — nơi người đọc bấm vào. */
  url: string;
  title: string | null;
  description: string | null;
  /** `og:site_name`, hoặc tên miền nếu trang không khai. */
  siteName: string | null;
  imageUrl: string | null;
}

/**
 * Một lựa chọn trong bình chọn.
 *
 * `votes` là **số người** đã chọn lựa chọn này (mỗi người một phiếu/lựa chọn),
 * `me` tính theo người xem — hai client nhận cùng tin nhưng `me` khác nhau, nên
 * không có "bản chung" đúng cho mọi người.
 */
export interface PollOption {
  id: Snowflake;
  label: string;
  votes: number;
  me: boolean;
}

/**
 * Bình chọn gắn vào một tin nhắn.
 *
 * `ended` do server tính (hết hạn theo `expiresAt`) — client hiển thị theo cờ này
 * chứ không tự so đồng hồ, vì đồng hồ máy người dùng có thể lệch vài phút.
 */
export interface Poll {
  question: string;
  options: PollOption[];
  allowMultiple: boolean;
  /** Số người đã bỏ phiếu (không phải tổng số phiếu khi `allowMultiple`). */
  totalVotes: number;
  expiresAt: string | null;
  ended: boolean;
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
  /** Đã gộp theo emoji, xếp theo lần thả đầu tiên. Rỗng nếu chưa ai thả. */
  reactions: ReactionSummary[];
  /**
   * Xem trước liên kết. Rỗng khi tin không có URL, hoặc server chưa tải xong
   * (embed tới sau bằng `MESSAGE_UPDATE`). Tuỳ chọn vì client cũ/dữ liệu cũ
   * không có trường này.
   */
  embeds?: Embed[];
  /**
   * Bình chọn gắn với tin. `null`/thiếu = tin thường. Server trả kèm cả khi poll
   * đã hết hạn để client hiện kết quả cuối cùng.
   */
  poll?: Poll | null;
  /**
   * Sticker gắn với tin. `null`/thiếu = tin thường. Tin sticker có `content`
   * rỗng (giống Discord): nội dung chữ và sticker không trộn trong một tin.
   */
  sticker?: Sticker | null;
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

/** Lý do báo cáo vi phạm — danh sách cố định, server kiểm lại. */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "violence",
  "self_harm",
  "impersonation",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export type ReportStatus = "open" | "reviewing" | "closed";

/** Kết quả gửi báo cáo. Nội dung báo cáo chỉ admin xem được. */
export interface ReportResult {
  id: Snowflake;
  status: ReportStatus;
  createdAt: string;
}

/** Đầu vào gửi báo cáo: đúng một trong `messageId` / `userId`. */
export interface ReportInput {
  messageId?: string;
  userId?: string;
  reason: ReportReason;
  details?: string;
}

/** Một người đang bị chặn (hiện trong danh sách để bỏ chặn). */
export interface BlockedUser {
  userId: Snowflake;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Người liên quan tới một báo cáo (chỉ admin thấy). */
export interface ReportParty {
  userId: Snowflake;
  username: string;
  displayName: string;
}

/**
 * Một dòng trong hàng đợi báo cáo của admin.
 *
 * `snapshotContent` là bản sao nội dung tin **tại thời điểm báo cáo** — tin có
 * thể đã bị sửa/xoá sau đó. Không chứa email hay thông tin đăng nhập của ai.
 */
export interface AdminReport {
  id: Snowflake;
  status: ReportStatus;
  reason: ReportReason;
  details: string | null;
  snapshotContent: string | null;
  messageId: Snowflake | null;
  channelId: Snowflake | null;
  channelName: string | null;
  guildId: Snowflake | null;
  guildName: string | null;
  reporter: ReportParty;
  target: ReportParty;
  createdAt: string;
}

/** Kèm số lượng theo từng trạng thái để UI hiện tab mà không phải gọi thêm. */
export interface AdminReportPage {
  reports: AdminReport[];
  counts: Record<ReportStatus, number>;
  hasMore: boolean;
}
