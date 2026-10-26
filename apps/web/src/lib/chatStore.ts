import type {
  FriendList,
  MessageRequestSummary,
  VoiceState,
  Channel,
  ChannelOverwrite,
  DmChannelSummary,
  Guild,
  GuildMemberSummary,
  Message,
  MessageMention,
  AdminReport,
  MessageSearchHit,
  ReportInput,
  ReportStatus,
  PresenceStatus,
  Role,
  Snowflake,
  User,
} from "@umaru/protocol";
import { parsePermissions, serializePermissions } from "@umaru/protocol";
import { ApiError, GatewayClient, type GatewayState } from "@umaru/sdk";
import { create } from "zustand";
import { clearAttachmentCache } from "./attachments.js";
import { clearAvatarCache, validateAvatar } from "./avatars.js";
import { dmPeer, dmTitle } from "./dms.js";
import { translate } from "./i18n.js";
import {
  VoiceAudioSession,
  beginVoiceAudio,
  classifyVoiceError,
  shouldPublishMicrophone,
  voiceAudioError,
  type VoiceAudioErrorKey,
  type VoiceAudioState,
} from "./voice.js";
import {
  NOTIFICATION_SETTINGS_KEY,
  decideNotify,
  notificationPermission,
  notificationText,
  parseNotificationSettings,
  requestNotificationPermission,
  showDesktopNotification,
  type NotificationSettings,
} from "./notifications.js";
import { readVerificationToken, withoutVerificationToken } from "./verification.js";
import {
  api,
  authedApi,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  refreshSession,
  storeTokens,
} from "./session.js";

export type Screen = "boot" | "auth" | "chat";

/** Phạm vi tìm kiếm: kênh đang mở, hoặc toàn server đang mở. */
export type SearchScope = "channel" | "guild";

/** Đối tượng đang được báo cáo trong hộp thoại. */
export interface ReportTarget {
  /** Báo cáo một tin cụ thể. */
  messageId?: string;
  /** Báo cáo một người (dùng khi báo cáo từ menu thành viên). */
  userId?: string;
  /** Tên hiển thị để hộp thoại nói rõ đang báo cáo ai. */
  label: string;
}

/** Thông báo ngắn hiển thị trên đầu khung chat. */
export interface Banner {
  kind: "success" | "error";
  text: string;
}

interface TypingEntry {
  userId: string;
  expiresAt: number;
}

interface ChatState {
  screen: Screen;
  me: User | null;
  gatewayStatus: GatewayState | "idle";
  guilds: Guild[];
  /** DM 1-1, mới nhất trước (từ READY + DM_CHANNEL_CREATE). */
  dms: DmChannelSummary[];
  channels: Record<string, Channel[]>;
  members: Record<string, GuildMemberSummary[]>;
  /** guildId → role của server, `position` giảm dần (mạnh nhất trước). */
  roles: Record<string, Role[]>;
  /** Panel Server Settings đang mở trong khung chat. */
  settingsOpen: boolean;
  /** Channel Settings đang mở cho kênh/category nào (null = đang đóng). */
  channelSettingsChannelId: string | null;
  /** channelId → danh sách ghi đè quyền (tải khi mở panel). */
  overwrites: Record<string, ChannelOverwrite[]>;
  activeGuildId: string | null;
  activeChannelId: string | null;
  messages: Record<string, Message[]>;
  /** channelId → số tin chưa đọc (tin của người khác sau mốc đã đọc). */
  unread: Record<string, number>;
  /** channelId → số tin trong đó có @gọi tên mình (badge đỏ, tính riêng). */
  mentions: Record<string, number>;
  /** channelId → quyền hiệu dụng của chính mình (server tính sẵn, gửi kèm READY). */
  permissions: Record<string, bigint>;
  /** Tab Mentions đang mở (main panel hiển thị hộp thư @gọi mình). */
  mentionsOpen: boolean;
  /** Danh sách mention tải từ REST; null = chưa tải lần nào. */
  mentionItems: MessageMention[] | null;
  mentionLoading: boolean;
  /** Trang vừa tải đầy → còn trang cũ hơn để lấy tiếp. */
  mentionHasMore: boolean;
  /** Panel tìm kiếm tin nhắn đang mở trong khung chat. */
  searchOpen: boolean;
  /** Từ khoá đang gõ (chưa chắc đã tìm — bấm Enter/tìm mới gọi API). */
  searchQuery: string;
  /** Tìm trong kênh đang mở hay toàn server đang mở. */
  searchScope: SearchScope;
  /** Từ khoá của lần tìm gần nhất (dùng để tô sáng kết quả). */
  searchSubmittedFor: string;
  /** Kết quả tìm kiếm; null = chưa tìm lần nào. */
  searchResults: MessageSearchHit[] | null;
  searchLoading: boolean;
  searchHasMore: boolean;
  /** Tin cần cuộn tới và tô sáng sau khi nhảy từ kết quả tìm kiếm. */
  highlightMessageId: string | null;
  /** Panel thành viên của group DM đang mở (đổi tên, thêm/mời ra, rời nhóm). */
  groupPanelOpen: boolean;
  /** Đang gọi API nhóm → khoá nút để không bấm hai lần. */
  groupBusy: boolean;
  /** Panel "Tin đã ghim" của kênh đang mở. */
  pinsOpen: boolean;
  /** Tin ghim của `pinsChannelId`; null = chưa tải. */
  pins: Message[] | null;
  pinsLoading: boolean;
  /** Kênh sở hữu danh sách `pins` — đổi kênh là bỏ dữ liệu cũ. */
  pinsChannelId: string | null;
  /** Panel "Người đã chặn" đang mở. */
  blocksOpen: boolean;
  /** Danh sách người đã chặn; null = chưa tải lần nào. */
  blocks: GuildMemberSummary[] | null;
  blocksLoading: boolean;
  /** Hộp thoại báo cáo đang mở (một tin hoặc một người). */
  reportTarget: ReportTarget | null;
  /** Đang gửi báo cáo — khoá nút để không gửi hai lần. */
  reportSending: boolean;
  /** Đang tải ảnh đại diện mới (khoá nút để không tải hai lần). */
  avatarUploading: boolean;
  /** Lỗi riêng của avatar (hiện trong panel hồ sơ). */
  avatarError: string | null;
  /** `null` = chưa kiểm tra; dùng để ẩn lối vào khu quản trị. */
  admin: boolean | null;
  /** Hàng đợi báo cáo cho admin; `null` = chưa tải. */
  adminReports: AdminReport[] | null;
  adminCounts: Record<ReportStatus, number> | null;
  adminHasMore: boolean;
  adminStatusFilter: ReportStatus;
  adminLoading: boolean;
  typing: Record<string, TypingEntry[]>;
  presence: Record<string, PresenceStatus>;
  /** Bạn bè + lời mời hai chiều + quyền riêng tư DM; `null` = chưa tải lần nào. */
  friends: FriendList | null;
  friendsLoading: boolean;
  /** Ô nhập username trong panel bạn bè (giữ ở store để đổi tab không mất chữ). */
  friendQuery: string;
  /** Panel bạn bè đang mở (thay khung chat, giống panel người đã chặn). */
  friendsOpen: boolean;
  /** Yêu cầu nhắn tin đang chờ mình duyệt (người lạ mở DM khi mình đặt "chỉ bạn bè"). */
  messageRequests: MessageRequestSummary[];
  messageRequestsLoading: boolean;
  /** Bật/tắt thông báo (lưu trong localStorage, không cần server). */
  notificationSettings: NotificationSettings;
  /** Quyền thông báo của trình duyệt; `unsupported` = không có Notification API. */
  notificationPermission: NotificationPermission | "unsupported";
  /**
   * Ai đang ở phòng thoại nào (danh sách phẳng, mỗi người một phòng mỗi server).
   * Server là nguồn sự thật: mọi thay đổi đến qua `VOICE_STATE_UPDATE`.
   */
  voiceStates: VoiceState[];
  /**
   * Phiên **âm thanh** của phòng đang ngồi. `null` = không ở phòng nào.
   * Tách khỏi `voiceStates`: trạng thái (ai ở phòng nào) luôn đúng dù SFU hỏng;
   * ở đây chỉ nói "có tiếng hay không" và vì sao.
   */
  voiceAudio: VoiceAudioState | null;
  /**
   * `userId` của những người **đang nói** trong phòng mình đang ngồi, lấy từ SFU
   * (`ActiveSpeakersChanged`). Cố tình **không** đi qua gateway: đổi vài lần mỗi
   * giây, đẩy lên server chỉ tốn băng thông và làm đèn của người khác nhấp nháy
   * theo độ trễ mạng. Rỗng khi không có âm thanh — trạng thái phòng vẫn đúng.
   */
  voiceSpeakers: string[];
  error: string | null;
  notice: string | null;
  /** Thông báo một dòng (xác thực email, gửi lại mail...) — tự tắt được. */
  banner: Banner | null;
  busy: boolean;

  boot(): Promise<void>;
  login(email: string, password: string): Promise<boolean>;
  register(input: {
    username: string;
    displayName: string;
    email: string;
    password: string;
    acceptedTerms: true;
  }): Promise<boolean>;
  logout(): Promise<void>;
  startSession(): Promise<void>;
  connectGateway(): Promise<void>;
  selectGuild(guildId: string): void;
  /** Chọn view Home (danh sách DM). */
  selectHome(): void;
  selectDm(channelId: string): Promise<void>;
  /** Mở (hoặc lấy lại) DM với một user rồi chọn nó. */
  openDm(recipientId: string): Promise<void>;
  selectChannel(channelId: string): Promise<void>;
  /** Mở tab Mentions, tải lại trang đầu của hộp thư @gọi mình. */
  openMentions(): Promise<void>;
  closeMentions(): void;
  /** Nối thêm một trang cũ hơn (cursor `before` = mention cuối đang có). */
  loadMoreMentions(): Promise<void>;
  /** Nhảy từ tab Mentions sang kênh chứa tin và đóng tab. */
  jumpToMention(mention: MessageMention): Promise<void>;
  /** Mở panel tìm kiếm (mặc định tìm trong kênh đang mở). */
  openSearch(): void;
  closeSearch(): void;
  setSearchQuery(query: string): void;
  setSearchScope(scope: SearchScope): void;
  /** Chạy tìm kiếm cho `searchQuery`; `q` dưới 2 ký tự thì không gọi API. */
  runSearch(): Promise<void>;
  /** Nối thêm một trang kết quả cũ hơn (cursor `before` = id tin cuối). */
  loadMoreSearch(): Promise<void>;
  /** Nhảy tới tin trong kết quả: mở đúng kênh, tải tới tin đó rồi tô sáng. */
  openSearchHit(hit: MessageSearchHit): Promise<void>;
  /** Xoá badge của kênh + báo server mốc đã đọc mới nhất. */
  markRead(channelId: string): void;
  loadMessages(channelId: string): Promise<void>;
  /** Gửi tin; `files` đi kèm bằng multipart, `replyToId` để trả lời một tin. */
  sendMessage(
    content: string,
    options?: { files?: File[]; replyToId?: string },
  ): Promise<boolean>;
  /** Sửa nội dung tin của mình; server đã đẩy `MESSAGE_UPDATE` cho mọi client. */
  editMessage(messageId: string, content: string): Promise<boolean>;
  /** Xoá tin của mình (hoặc bất kỳ tin nào nếu có `MANAGE_MESSAGES`). */
  deleteMessage(messageId: string): Promise<boolean>;
  createGuild(name: string): Promise<void>;
  createChannel(name: string, type?: "guild_text" | "category"): Promise<void>;
  /** Đổi category chứa kênh (null = ra gốc); quyền hiệu dụng tính lại theo category mới. */
  moveChannel(channelId: string, parentId: string | null): Promise<boolean>;
  /**
   * Đổi thứ tự trong sidebar: chèn kênh vào chỉ số `position` của nhóm kênh cùng
   * category (`parentId` null = nhóm gốc). Server renumber anh em rồi phát
   * CHANNEL_UPDATE nên các client khác cũng xếp lại ngay.
   */
  reorderChannel(
    channelId: string,
    parentId: string | null,
    position: number,
  ): Promise<boolean>;
  copyInvite(): Promise<void>;
  openSettings(): void;
  closeSettings(): void;
  /** Tạo role; `permissions` là bitfield dạng chuỗi (serializePermissions). */
  createRole(input: { name: string; color?: number; permissions?: string }): Promise<Role | null>;
  editRole(
    roleId: string,
    input: { name?: string; color?: number; permissions?: string },
  ): Promise<boolean>;
  /**
   * Kéo-thả đổi cấp role: `position` = thứ hạng trên xuống (0 = trên cùng, không
   * tính `@everyone`). Server renumber cả dãy và phát `ROLE_UPDATE` cho những
   * role đổi chỗ nên các client khác xếp lại ngay.
   */
  reorderRole(roleId: string, position: number): Promise<boolean>;
  deleteRole(roleId: string): Promise<boolean>;
  /** Gán/thu một role của thành viên; server đẩy `GUILD_MEMBER_UPDATE` cho cả server. */
  setMemberRole(memberId: string, roleId: string, assign: boolean): Promise<boolean>;
  /** Mở Channel Settings của một kênh/category + tải ghi đè quyền (kèm của category cha). */
  openChannelSettings(channelId: string): Promise<void>;
  closeChannelSettings(): void;
  /** Lưu ghi đè quyền (0/0 = xoá, trở về kế thừa role). */
  setOverwrite(
    channelId: string,
    targetType: "role" | "member",
    targetId: string,
    allow: bigint,
    deny: bigint,
  ): Promise<boolean>;
  resetOverwrite(
    channelId: string,
    targetType: "role" | "member",
    targetId: string,
  ): Promise<boolean>;
  /** Tạo group DM với 2–9 người khác rồi mở luôn. */
  createGroupDm(recipientIds: string[], name?: string): Promise<boolean>;
  /** Thêm một người vào group DM đang mở. */
  addGroupMember(userId: string): Promise<boolean>;
  /** Mời một người ra khỏi nhóm (chỉ chủ nhóm). */
  removeGroupMember(userId: string): Promise<boolean>;
  /** Rời nhóm đang mở; nhóm của mình biến khỏi sidebar ngay. */
  leaveGroupDm(): Promise<boolean>;
  /** Đổi tên nhóm (`null` = bỏ tên). */
  renameGroupDm(name: string | null): Promise<boolean>;
  openGroupPanel(): void;
  closeGroupPanel(): void;
  /** Mở/đóng panel tin ghim của kênh đang mở (mở là tải lại). */
  openPins(): Promise<void>;
  closePins(): void;
  /** Ghim hoặc bỏ ghim một tin; danh sách ghim cập nhật tại chỗ. */
  togglePin(messageId: string): Promise<boolean>;
  /** Nhảy tới một tin ghim trong kênh đang mở (tải thêm trang cũ nếu cần). */
  jumpToPinnedMessage(messageId: string): Promise<void>;
  /** Mở panel người đã chặn + tải lại danh sách. */
  openBlocks(): Promise<void>;
  closeBlocks(): void;
  /** Chặn một người; DM với họ biến khỏi danh sách ngay. */
  blockUser(userId: string): Promise<boolean>;
  unblockUser(userId: string): Promise<boolean>;
  /** Mở/đóng hộp thoại báo cáo. */
  openReport(target: ReportTarget): void;
  closeReport(): void;
  /** Gửi báo cáo; `true` khi thành công (hộp thoại tự đóng). */
  submitReport(input: Omit<ReportInput, "messageId" | "userId">): Promise<boolean>;
  /** Hỏi server xem tài khoản hiện tại có quyền xem hàng đợi báo cáo không. */
  checkAdmin(): Promise<boolean>;
  /** Tải hàng đợi báo cáo (admin). `status` mới sẽ đổi tab đang xem. */
  loadAdminReports(status?: ReportStatus): Promise<void>;
  /** Nối thêm một trang cũ hơn theo cursor `before`. */
  loadMoreAdminReports(): Promise<void>;
  /** Đổi trạng thái xử lý; dòng được thay tại chỗ, không tải lại cả trang. */
  updateReportStatus(reportId: string, status: ReportStatus): Promise<boolean>;
  /**
   * Đặt ảnh đại diện từ tệp người dùng chọn. Kiểm MIME/kích thước ở client để
   * báo lỗi ngay, server vẫn kiểm lại bằng magic bytes.
   */
  uploadAvatar(file: File): Promise<boolean>;
  /** Gỡ ảnh đại diện (quay lại chữ cái đầu). */
  removeAvatar(): Promise<boolean>;
  clearAvatarError(): void;
  /** Gửi lại mail xác thực; ở dev có token echo thì xác thực luôn. */
  resendVerification(): Promise<void>;
  /** Xác thực email bằng token trong link (`?verifyToken=...`). */
  verifyEmailToken(token: string): Promise<boolean>;
  clearBanner(): void;
  /**
   * Vào/ra phòng thoại của một kênh voice. Đang ở đúng kênh đó thì gọi là **ra**,
   * nên một nút bấm dùng cho cả hai chiều (hành vi quen thuộc của Discord).
   */
  toggleVoice(channelId: string): Promise<void>;
  /** Bật/tắt mic của mình trong phòng đang ở. */
  toggleVoiceMute(): Promise<void>;
  /** Bật/tắt tai nghe (deafen) của mình trong phòng đang ở. */
  toggleVoiceDeafen(): Promise<void>;
  /** Mở panel bạn bè + tải lại danh sách. */
  openFriends(): Promise<void>;
  closeFriends(): void;
  setFriendQuery(query: string): void;
  /** Gửi lời mời kết bạn bằng username; trả `true` khi thành công. */
  addFriend(username: string): Promise<boolean>;
  /** Đồng ý lời mời; danh sách cập nhật khi server phát `FRIEND_ADD`. */
  acceptFriend(userId: string): Promise<boolean>;
  /** Huỷ kết bạn / từ chối lời mời / huỷ lời mời đã gửi. */
  removeFriend(userId: string): Promise<boolean>;
  /** Đổi ai được nhắn tin cho mình (`everyone` | `friends`). */
  setDmPrivacy(privacy: "everyone" | "friends"): Promise<boolean>;
  /** Đồng ý một yêu cầu nhắn tin → DM hiện trong sidebar và mở luôn. */
  /** Thử kết nối lại âm thanh của phòng hiện tại (sau lỗi mạng). */
  retryVoiceAudio(): Promise<void>;
  acceptMessageRequest(channelId: string): Promise<boolean>;
  /** Từ chối → cuộc trò chuyện bị xoá với cả hai. */
  declineMessageRequest(channelId: string): Promise<boolean>;
  /** Bật/tắt thông báo máy (bật thì xin quyền trình duyệt ngay trong thao tác này). */
  setDesktopNotifications(enabled: boolean): Promise<void>;
  /** Bật/tắt số chưa đọc trên tiêu đề tab. */
  setTabTitleNotifications(enabled: boolean): void;
  notifyTyping(): void;
  clearNotice(): void;
  clearError(): void;
}

let gateway: GatewayClient | null = null;
const typingSentAt = new Map<string, number>();
const TYPING_THROTTLE_MS = 7_000;
/** Số dòng mỗi trang của tab Mentions (server chặn tối đa 100). */
const MENTION_PAGE_SIZE = 50;
/** Số kết quả mỗi trang tìm kiếm (server chặn tối đa 50). */
export const SEARCH_PAGE_SIZE = 25;
/** Độ dài tối thiểu của từ khoá — trùng với ràng buộc phía server. */
export const SEARCH_MIN_LENGTH = 2;
/** Số báo cáo mỗi trang trong hàng đợi admin (server chặn tối đa 100). */
export const ADMIN_PAGE_SIZE = 25;
/** Số trang tin nhắn tải thêm tối đa khi nhảy tới một kết quả tìm kiếm cũ. */
const SEARCH_JUMP_MAX_PAGES = 8;
/** Tránh bắn POST /read theo từng tin khi kênh đang mở nhận tin liên tục. */
/** Đóng panel ghim + xoá dữ liệu của kênh trước (tránh hiện nhầm ghim khi đổi kênh). */
const CLOSED_PINS = {
  pinsOpen: false,
  pins: null,
  pinsChannelId: null,
  groupPanelOpen: false,
} as const;
const ackedAt = new Map<string, number>();
const ACK_THROTTLE_MS = 3_000;

function ackChannel(channelId: string, messageId?: string, force = false): void {
  const now = Date.now();
  const last = ackedAt.get(channelId) ?? 0;
  if (!force && now - last < ACK_THROTTLE_MS) return;
  ackedAt.set(channelId, now);
  void authedApi.ackRead(channelId, messageId).catch(() => undefined);
}

/** Một phiên âm thanh cho mỗi tab (một phòng tại một thời điểm mỗi server). */
let voiceSession: VoiceAudioSession | null = null;

/**
 * Bật/tắt mic + loa theo trạng thái **server** vừa phát. Không tự quyết định
 * mute ở client: `VOICE_STATE_UPDATE` là nguồn sự thật duy nhất, nên hai tab
 * của cùng một người không thể nói hai điều khác nhau.
 */
function applyVoiceAudio(state: ChatState): void {
  if (voiceSession === null) return;
  const mine = state.voiceStates.find((entry) => entry.userId === state.me?.id);
  const audio = state.voiceAudio;
  if (audio === null || audio.status !== "connected") {
    // Chưa nối xong (hoặc SFU không có) — chưa có gì để bật/tắt.
    voiceSession.setDeafened(mine?.selfDeaf ?? false);
    return;
  }
  void voiceSession.setMicrophone(
    mine === undefined
      ? false
      : shouldPublishMicrophone({
          // `canPublish` do server quyết định lúc cấp token (quyền `SPEAK`).
          canPublish: audio.canPublish,
          selfMute: mine.selfMute,
          selfDeaf: mine.selfDeaf,
        }),
  );
  voiceSession.setDeafened(mine?.selfDeaf ?? false);
}

/**
 * Mở phiên âm thanh cho phòng vừa vào. Mọi lỗi ở đây **không** đá người dùng ra
 * khỏi phòng: trạng thái vẫn đúng, chỉ là không có tiếng — và UI nói rõ lý do.
 */
async function startVoiceAudio(
  channelId: string,
  get: () => ChatState,
  set: (patch: Partial<ChatState>) => void,
): Promise<void> {
  await stopVoiceAudio();
  set({ voiceAudio: beginVoiceAudio(channelId), voiceSpeakers: [] });
  try {
    const token = await authedApi.getVoiceToken(channelId);
    const session = new VoiceAudioSession();
    const mine = get().voiceStates.find((entry) => entry.userId === get().me?.id);
    // Gán trước `connect` để callback "đang nói" của phiên này tự loại mình khi
    // đã có phiên mới hơn (bấm đổi phòng liên tục) — nếu không, phiên cũ rò rỉ
    // đèn của phòng cũ sang phòng mới.
    voiceSession = session;
    await session.connect({
      url: token.url,
      token: token.token,
      canPublish: token.canPublish,
      selfMute: mine?.selfMute ?? false,
      selfDeaf: mine?.selfDeaf ?? false,
      onSpeakers: (speakers) => {
        if (voiceSession !== session) return;
        set({ voiceSpeakers: speakers });
      },
    });
    set({
      voiceAudio: { channelId, status: "connected", errorKey: null, canPublish: token.canPublish },
    });
  } catch (error) {
    const errorKey = classifyVoiceError(error);
    await stopVoiceAudio();
    // 503 và 404 không phải "lỗi" của người dùng: server chưa bật SFU, hoặc
    // người dùng đã bị đưa ra khỏi phòng. Hiện trạng thái khác để không doạ.
    set({
      voiceAudio:
        errorKey === "voiceErrorNotConfigured"
          ? { channelId: null, status: "unavailable" as const, errorKey, canPublish: false }
          : voiceAudioError(channelId, errorKey),
    });
  }
}

async function stopVoiceAudio(): Promise<void> {
  const session = voiceSession;
  voiceSession = null;
  if (session !== null) await session.disconnect();
}

/**
 * Báo tin mới. Toàn bộ quyết định nằm ở `notifications.ts` (hàm thuần, có test);
 * ở đây chỉ lo phần "lấy dữ liệu từ state" và gọi API trình duyệt.
 *
 * Có cooldown theo kênh để một cuộc trò chuyện sôi nổi không thành 20 popup, và
 * bỏ qua khi cửa sổ đang focus đúng kênh đó (đang đọc thì không cần báo).
 */
const notifiedAt = new Map<string, number>();

function maybeNotify(message: Message, state: ChatState): void {
  const dm = state.dms.find((entry) => entry.channel.id === message.channelId);
  const important = dm !== undefined || isMention(message.content, state.me?.username);
  const verdict = decideNotify({
    authorId: message.authorId as string,
    meId: state.me?.id ?? null,
    channelId: message.channelId as string,
    activeChannelId: state.activeChannelId,
    windowFocused: typeof document === "undefined" ? true : document.hasFocus(),
    desktopEnabled: state.notificationSettings.desktop,
    important,
    lastNotifiedAt: notifiedAt.get(message.channelId as string) ?? null,
    now: Date.now(),
  });
  if (!verdict.notify) return;
  notifiedAt.set(message.channelId as string, Date.now());

  const authorName = displayNameOf(message.authorId as string, state);
  const channelLabel =
    dm !== undefined
      ? dmTitle(dm)
      : `#${channelNameOf(message.channelId as string, state) ?? "?"}`;
  showDesktopNotification(
    notificationText({ authorName, channelLabel, content: message.content, important }),
  );
}

/**
 * Tên hiển thị của một người, tra theo thứ tự rẻ → đắt: chính mình, thành viên
 * các guild đang cache, rồi người trong DM. Không gọi API: thông báo phải hiện
 * ngay, và người gửi tin trong kênh mình đọc gần như luôn có trong cache.
 */
function displayNameOf(userId: string, state: ChatState): string {
  if (state.me?.id === userId) return state.me.displayName;
  for (const list of Object.values(state.members)) {
    const found = list.find((member) => (member.userId as string) === userId);
    if (found !== undefined) return found.displayName;
  }
  for (const dm of state.dms) {
    const found = dm.recipients.find((entry) => (entry.userId as string) === userId);
    if (found !== undefined) return found.displayName;
  }
  return translate("unknownUser");
}

function channelNameOf(channelId: string, state: ChatState): string | null {
  for (const list of Object.values(state.channels)) {
    const found = list.find((channel) => (channel.id as string) === channelId);
    if (found?.name != null) return found.name;
  }
  return null;
}

/** Ghi cài đặt xuống localStorage; lỗi (chế độ riêng tư, quota) không được làm hỏng UI. */
function applyNotificationSettings(settings: NotificationSettings): void {
  useChat.setState({ notificationSettings: settings });
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Trình duyệt chặn storage: giữ cài đặt trong bộ nhớ cho phiên này.
  }
}

const initialState = {
  screen: "boot" as Screen,
  me: null,
  gatewayStatus: "idle" as GatewayState | "idle",
  guilds: [],
  dms: [],
  channels: {},
  members: {},
  roles: {},
  settingsOpen: false,
  channelSettingsChannelId: null,
  overwrites: {} as Record<string, ChannelOverwrite[]>,
  activeGuildId: null,
  activeChannelId: null,
  messages: {},
  unread: {},
  mentions: {},
  permissions: {} as Record<string, bigint>,
  mentionsOpen: false,
  mentionItems: null,
  mentionLoading: false,
  mentionHasMore: false,
  searchOpen: false,
  searchQuery: "",
  searchScope: "channel" as SearchScope,
  searchSubmittedFor: "",
  searchResults: null,
  searchLoading: false,
  searchHasMore: false,
  highlightMessageId: null,
  groupPanelOpen: false,
  groupBusy: false,
  pinsOpen: false,
  pins: null,
  pinsLoading: false,
  pinsChannelId: null,
  blocksOpen: false,
  blocks: null,
  blocksLoading: false,
  reportTarget: null,
  reportSending: false,
  avatarUploading: false,
  avatarError: null,
  admin: null,
  adminReports: null,
  adminCounts: null,
  adminHasMore: false,
  adminStatusFilter: "open" as ReportStatus,
  adminLoading: false,
  typing: {},
  presence: {},
  friends: null,
  friendsLoading: false,
  friendQuery: "",
  friendsOpen: false,
  messageRequests: [],
  messageRequestsLoading: false,
  notificationSettings: parseNotificationSettings(
    typeof localStorage === "undefined" ? null : localStorage.getItem(NOTIFICATION_SETTINGS_KEY),
  ),
  notificationPermission: notificationPermission(),
  voiceStates: [],
  voiceAudio: null,
  voiceSpeakers: [],
  error: null,
  notice: null,
  banner: null,
  busy: false,
};

/** Trường hồ sơ có thể đổi; presence là ephemeral nên không nằm ở đây. */
type ProfileFields = Pick<User, "id" | "username" | "displayName" | "avatarUrl">;

/**
 * Áp hồ sơ mới (avatar/tên) vào mọi nơi đang hiển thị người đó: chính mình,
 * thành viên các server đang có trong bộ nhớ, và người trong danh sách DM.
 * Dùng chung cho phản hồi REST (`PUT /users/@me/avatar`) và sự kiện `USER_UPDATE`
 * nên hai tab / hai người thấy avatar đổi cùng lúc.
 */
export function applyProfile(state: ChatState, profile: ProfileFields): Partial<ChatState> {
  const fields = {
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
  };
  const members: ChatState["members"] = {};
  for (const [guildId, list] of Object.entries(state.members)) {
    members[guildId] = list.map((member) =>
      member.userId === profile.id ? { ...member, ...fields } : member,
    );
  }
  return {
    me: state.me !== null && state.me.id === profile.id ? { ...state.me, ...fields } : state.me,
    members,
    dms: state.dms.map((dm) => {
      const recipients = dm.recipients.map((member) =>
        member.userId === profile.id ? { ...member, ...fields } : member,
      );
      // Giữ `recipient` (DM 1-1) đồng bộ với phần tử tương ứng trong `recipients`.
      const recipient =
        dm.recipient !== null && dm.recipient.userId === profile.id
          ? { ...dm.recipient, ...fields }
          : dm.recipient;
      return { ...dm, recipients, recipient };
    }),
  };
}

/**
 * Đảm bảo tin `messageId` đã có trong bộ nhớ của kênh, rồi cuộn tới và tô sáng.
 * Kết quả tìm kiếm / tin ghim có thể cũ hơn trang tin đang giữ → lật thêm trang
 * (có giới hạn) thay vì quét cả kênh.
 */
async function revealMessage(
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  channelId: string,
  messageId: string,
): Promise<void> {
  for (let page = 0; page <= SEARCH_JUMP_MAX_PAGES; page += 1) {
    const loaded = get().messages[channelId];
    if (loaded === undefined) {
      await get().loadMessages(channelId);
      continue;
    }
    if (loaded.some((message) => message.id === messageId)) break;
    if (loaded.length === 0) break;
    try {
      const older = await authedApi.listMessages(channelId, { before: loaded[0]!.id as string });
      if (older.length === 0) break;
      set({
        messages: {
          ...get().messages,
          [channelId]: [...[...older].reverse(), ...loaded],
        },
      });
    } catch (error) {
      set({ error: describeError(error) });
      break;
    }
  }

  set({ highlightMessageId: messageId });
  // Cuộn sau khi React đã vẽ lại danh sách tin, rồi bỏ tô sáng.
  setTimeout(() => {
    document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: "center" });
  }, 0);
  setTimeout(() => {
    if (get().highlightMessageId === messageId) set({ highlightMessageId: null });
  }, 2_500);
}

/** Cập nhật một tin đã có trong state + danh sách ghim (nếu đang mở đúng kênh). */
export function patchMessage(
  state: ChatState,
  message: { id: string; channelId: string; pinned: boolean },
): Partial<ChatState> {
  const channelId = message.channelId;
  const list = state.messages[channelId];
  const messages =
    list === undefined
      ? state.messages
      : {
          ...state.messages,
          [channelId]: list.map((item) =>
            item.id === message.id ? { ...item, pinned: message.pinned } : item,
          ),
        };

  let pins = state.pins;
  if (pins !== null && state.pinsChannelId === channelId) {
    const without = pins.filter((item) => item.id !== message.id);
    const full = list?.find((item) => item.id === message.id);
    pins = message.pinned && full !== undefined ? [full, ...without] : without;
  }

  return { messages, pins };
}

export const useChat = create<ChatState>()((set, get) => ({
  ...initialState,

  async boot() {
    // Link xác thực email có thể mở ở tab chưa đăng nhập → xử lý trước khi
    // quyết định vào app hay vào màn đăng nhập.
    if (typeof window !== "undefined") {
      const token = readVerificationToken(window.location.search);
      if (token !== null) {
        // Xoá token khỏi URL ngay, kể cả khi xác thực lỗi.
        window.history.replaceState({}, "", withoutVerificationToken(window.location.href));
        await get().verifyEmailToken(token);
      }
    }
    if (getAccessToken() === null) {
      if (getRefreshToken() !== null && (await refreshSession())) {
        return get().startSession();
      }
      set({ screen: "auth" });
      return;
    }
    try {
      await get().startSession();
    } catch {
      if (await refreshSession()) {
        await get().startSession();
        return;
      }
      set({ screen: "auth" });
    }
  },

  async login(email, password) {
    set({ busy: true, error: null });
    try {
      const result = await api.login(email, password);
      storeTokens(result);
      await get().startSession();
      set({ busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: describeError(error) });
      return false;
    }
  },

  async register(input) {
    set({ busy: true, error: null });
    try {
      const result = await api.register(input);
      storeTokens(result);
      await get().startSession();
      set({ busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: describeError(error) });
      return false;
    }
  },

  async logout() {
    const refreshToken = getRefreshToken();
    if (refreshToken !== null) {
      try {
        await api.logout(refreshToken);
      } catch {
        /* token đã hết hạn — vẫn xoá local */
      }
    }
    gateway?.close();
    gateway = null;
    clearTokens();
    // Giải phóng object URL của tệp đã tải (đổi tài khoản là không dùng lại được).
    clearAttachmentCache();
    clearAvatarCache();
    set({ ...initialState, screen: "auth" });
  },

  async startSession() {
    const me = await authedApi.getCurrentUser();
    set({ screen: "chat", me, error: null });
    void get().checkAdmin();
    await get().connectGateway();
  },

  async connectGateway() {
    const token = getAccessToken();
    if (token === null) throw new Error(translate("notSignedIn"));
    gateway?.close();

    const { url } = await api.getGatewayUrl();
    const client = new GatewayClient({
      url,
      token,
      // Access token sống 15 phút; socket có thể sống lâu hơn. Đọc token hiện tại
      // mỗi lần identify/resume thay vì giữ bản chụp lúc mở kết nối.
      getToken: getAccessToken,
      // Server đóng 4000 = token hết hạn (spec §2.1). Dùng chung `refreshSession`
      // với REST để hai nơi không tranh nhau refresh; hỏng thì trả null → client
      // về `closed` và `refreshSession` đã xoá token, app quay lại màn đăng nhập.
      onAuthFailure: async () => {
        const refreshed = await refreshSession();
        return refreshed ? getAccessToken() : null;
      },
    });
    gateway = client;

    client.onStateChange((state) => set({ gatewayStatus: state }));

    client.on("READY", (data) => {
      const channels: Record<string, Channel[]> = {};
      const members: Record<string, GuildMemberSummary[]> = {};
      const roles: Record<string, Role[]> = {};
      for (const snapshot of data.guilds) {
        channels[snapshot.guild.id] = snapshot.channels;
        members[snapshot.guild.id] = snapshot.members;
        roles[snapshot.guild.id] = snapshot.roles;
      }
      const guilds = data.guilds.map((snapshot) => snapshot.guild);
      const current = get();
      const guildId =
        current.activeGuildId !== null && guilds.some((g) => g.id === current.activeGuildId)
          ? current.activeGuildId
          : (guilds[0]?.id ?? null);
      const channelId = pickChannel(
        channels[guildId ?? ""] ?? [],
        current.activeChannelId ?? undefined,
      );
      const unread: Record<string, number> = {};
      const mentions: Record<string, number> = {};
      for (const readState of data.readStates) {
        if (readState.unread > 0) unread[readState.channelId] = readState.unread;
        if (readState.mentions > 0) mentions[readState.channelId] = readState.mentions;
      }
      // Giữ nguyên bigint trong state (không đưa vào JSON) — chỉ parse một lần lúc READY.
      const permissions = parsePermissionMap(data.channelPermissions ?? {});
      set({
        me: data.user,
        guilds,
        dms: data.dms,
        voiceStates: data.voiceStates ?? [],
        channels,
        members,
        roles,
        unread,
        mentions,
        permissions,
        activeGuildId: guildId,
        activeChannelId: channelId,
      });
      // Badge "yêu cầu nhắn tin" phải có ngay khi mở app, không đợi mở panel.
      // Lỗi mạng ở đây không được làm hỏng READY nên chỉ nuốt và bỏ qua.
      void authedApi.listMessageRequests().then(
        (messageRequests) => set({ messageRequests }),
        () => undefined,
      );
      if (channelId !== null) {
        void get().loadMessages(channelId);
        // READY vừa trả badge cho kênh đang mở → coi như đã đọc.
        const current = get();
        if (current.unread[channelId] !== undefined || current.mentions[channelId] !== undefined) {
          const { [channelId]: _u, ...rest } = current.unread;
          const { [channelId]: _m, ...restMentions } = current.mentions;
          set({ unread: rest, mentions: restMentions });
          ackChannel(channelId, undefined, true);
        }
      }
    });

    // Đọc trên thiết bị khác: badge của tab này tắt ngay, không đợi mở lại kênh.
    // Số liệu là của server (đã tính theo mốc GREATEST) nên chỉ việc thay thế.
    client.on("READ_STATE_UPDATE", (readState) => {
      const current = get();
      const unread = { ...current.unread };
      const mentions = { ...current.mentions };
      if (readState.unread > 0) unread[readState.channelId] = readState.unread;
      else delete unread[readState.channelId];
      if (readState.mentions > 0) mentions[readState.channelId] = readState.mentions;
      else delete mentions[readState.channelId];
      set({ unread, mentions });
    });

    client.on("DM_CHANNEL_CREATE", (summary) => {
      // Chỉ thêm vào sidebar: không tự nhảy vào cuộc, không đụng badge của người nhận.
      set({ dms: upsertDm(get().dms, summary) });
    });

    // Đổi tên nhóm / có người mới vào → summary đầy đủ, thay tại chỗ.
    client.on("DM_CHANNEL_UPDATE", (summary) => {
      set({ dms: upsertDm(get().dms, summary) });
    });

    // Bị mời ra khỏi nhóm (hoặc nhóm bị xoá): bỏ khỏi sidebar, đang mở thì về Home.
    client.on("DM_CHANNEL_DELETE", (data) => {
      const current = get();
      const wasActive = current.activeChannelId === (data.channelId as string);
      set({
        dms: current.dms.filter((dm) => dm.channel.id !== data.channelId),
        ...(wasActive
          ? {
              activeChannelId: null,
              activeGuildId: null,
              groupPanelOpen: false,
              pinsOpen: false,
            }
          : {}),
      });
    });

    client.on("MESSAGE_CREATE", (message) => {
      const current = get();
      const list = current.messages[message.channelId] ?? [];
      const patch: Partial<ChatState> = {
        messages: { ...current.messages, [message.channelId]: upsertMessage(list, message) },
      };
      if (message.authorId !== current.me?.id) {
        if (message.channelId === current.activeChannelId) {
          // Đang mở kênh → đọc luôn, không tăng badge.
          ackChannel(message.channelId, message.id as string);
        } else {
          patch.unread = {
            ...current.unread,
            [message.channelId]: (current.unread[message.channelId] ?? 0) + 1,
          };
          if (isMention(message.content, current.me?.username)) {
            patch.mentions = {
              ...current.mentions,
              [message.channelId]: (current.mentions[message.channelId] ?? 0) + 1,
            };
          }
        }
        maybeNotify(message, current);
      }
      set(patch);
    });

    client.on("MESSAGE_UPDATE", (data) => {
      const current = get();
      const list = current.messages[data.channelId];
      if (list === undefined) return;
      set({
        messages: {
          ...current.messages,
          [data.channelId]: list.map((message) =>
            message.id === data.id
              ? { ...message, content: data.content ?? message.content, editedAt: data.editedAt }
              : message,
          ),
        },
      });
    });

    client.on("MESSAGE_DELETE", (data) => {
      const current = get();
      const list = current.messages[data.channelId];
      set({
        messages:
          list === undefined
            ? current.messages
            : {
                ...current.messages,
                [data.channelId]: list.filter((message) => message.id !== data.id),
              },
        // Tab Mentions có thể đang mở và chứa tin vừa bị xoá (kể cả do người khác).
        mentionItems:
          current.mentionItems === null
            ? null
            : current.mentionItems.filter((item) => item.message.id !== data.id),
        // Panel ghim có thể đang mở và chứa tin vừa bị xoá.
        pins:
          current.pins === null ? null : current.pins.filter((item) => item.id !== data.id),
      });
    });

    client.on("PERMISSIONS_UPDATE", (data) => {
      // Server gửi cả map → thay thế luôn; quyền vừa mất thì nút tương ứng biến mất.
      set({ permissions: parsePermissionMap(data.channelPermissions) });
    });

    client.on("TYPING_START", (data) => {
      const current = get();
      const now = Date.now();
      const entries = (current.typing[data.channelId] ?? []).filter(
        (entry) => entry.userId !== data.userId && entry.expiresAt > now,
      );
      entries.push({ userId: data.userId, expiresAt: Date.now() + 6_000 });
      set({ typing: { ...current.typing, [data.channelId]: entries } });
    });

    // Avatar/tên đổi → mọi nơi đang hiển thị người đó cập nhật ngay, không F5.
    client.on("USER_UPDATE", (data) => {
      set(applyProfile(get(), data.user));
    });

    // Ghim/bỏ ghim → chip 📌 và panel ghim đổi ngay ở mọi client.
    client.on("MESSAGE_PIN_UPDATE", (data) => {
      set(patchMessage(get(), data));
    });

    /**
     * `VOICE_STATE_UPDATE`: `channelId: null` = người đó rời phòng. Một người chỉ
     * ở một phòng mỗi server nên khi nhận trạng thái mới là **thay** bản ghi cũ
     * của chính họ trong guild đó, không phải thêm dòng.
     */
    client.on("VOICE_STATE_UPDATE", (data) => {
      set((current) => {
        const others = current.voiceStates.filter(
          (entry) => !(entry.userId === data.userId && entry.guildId === data.guildId),
        );
        if (data.channelId === null) return { voiceStates: others };
        return {
          voiceStates: [
            ...others,
            {
              guildId: data.guildId,
              channelId: data.channelId,
              userId: data.userId,
              selfMute: data.selfMute,
              selfDeaf: data.selfDeaf,
              joinedAt: data.joinedAt,
            },
          ],
        };
      });
      if (data.userId !== get().me?.id) return;
      const audio = get().voiceAudio;
      if (data.channelId === null) {
        // Bị đưa ra khỏi phòng (mất `VIEW_CHANNEL`, hoặc tab khác rời): phải
        // **ngắt mic ngay**. Giữ kết nối tới phòng mình không còn quyền ở là
        // đúng loại lỗi mà lớp quyền phía server đang cố ngăn.
        if (audio !== null) {
          void stopVoiceAudio();
          set({ voiceAudio: null, voiceSpeakers: [] });
        }
        return;
      }
      if (audio !== null && audio.channelId !== data.channelId) {
        // Cùng một người đổi phòng ở tab khác: tab này đi theo, thay vì tiếp tục
        // nói trong phòng cũ mà server đã coi là đã rời.
        void startVoiceAudio(data.channelId, get, (patch) => set(patch));
        return;
      }
      // Mute/deafen của chính mình (kể cả thao tác từ tab khác) → áp vào media.
      applyVoiceAudio(get());
    });

    /**
     * Quan hệ bạn bè: server là nguồn sự thật, client chỉ áp thay đổi. `FRIEND_ADD`
     * và `FRIEND_REMOVE` phát cho **cả hai** phía nên danh sách hai bên không lệch.
     */
    client.on("FRIEND_REQUEST_CREATE", (request) => {
      const current = get().friends;
      if (current === null) return; // chưa mở panel: lần mở sẽ tải đủ
      set({
        friends: {
          ...current,
          incoming: [request, ...current.incoming.filter((r) => r.user.id !== request.user.id)],
        },
      });
    });
    client.on("FRIEND_ADD", (friend) => {
      const current = get().friends;
      if (current === null) return;
      set({
        friends: {
          ...current,
          friends: [friend, ...current.friends.filter((f) => f.user.id !== friend.user.id)],
          incoming: current.incoming.filter((r) => r.user.id !== friend.user.id),
          outgoing: current.outgoing.filter((r) => r.user.id !== friend.user.id),
        },
      });
    });
    client.on("FRIEND_REMOVE", (data) => {
      const current = get().friends;
      if (current === null) return;
      set({
        friends: {
          ...current,
          friends: current.friends.filter((f) => f.user.id !== data.userId),
          incoming: current.incoming.filter((r) => r.user.id !== data.userId),
          outgoing: current.outgoing.filter((r) => r.user.id !== data.userId),
        },
      });
    });
    client.on("MESSAGE_REQUEST_CREATE", (request) => {
      const current = get();
      set({
        messageRequests: [
          request,
          ...current.messageRequests.filter((row) => row.channelId !== request.channelId),
        ],
      });
    });
    client.on("MESSAGE_REQUEST_REMOVE", (data) => {
      set({
        messageRequests: get().messageRequests.filter((row) => row.channelId !== data.channelId),
      });
    });

    client.on("USER_SETTINGS_UPDATE", (settings) => {
      const current = get().friends;
      if (current === null) return;
      set({ friends: { ...current, dmPrivacy: settings.dmPrivacy } });
    });

    client.on("PRESENCE_UPDATE", (data) => {
      set({ presence: { ...get().presence, [data.userId]: data.status } });
    });

    client.on("GUILD_MEMBER_ADD", (data) => {
      const current = get();
      const members = current.members[data.guildId] ?? [];
      if (members.some((member) => member.userId === data.member.userId)) return;
      set({ members: { ...current.members, [data.guildId]: [...members, data.member] } });
    });

    // Gán/thu role → chip role của thành viên đổi ngay ở mọi client trong server.
    client.on("GUILD_MEMBER_UPDATE", (data) => {
      const current = get();
      const members = current.members[data.guildId];
      if (members === undefined) return;
      const exists = members.some((member) => member.userId === data.member.userId);
      set({
        members: {
          ...current.members,
          [data.guildId]: exists
            ? members.map((member) =>
                member.userId === data.member.userId ? data.member : member,
              )
            : [...members, data.member],
        },
      });
    });

    client.on("ROLE_CREATE", (data) => {
      const current = get();
      set({
        roles: {
          ...current.roles,
          [data.guildId]: upsertRole(current.roles[data.guildId] ?? [], data.role),
        },
      });
    });

    client.on("ROLE_UPDATE", (data) => {
      const current = get();
      set({
        roles: {
          ...current.roles,
          [data.guildId]: upsertRole(current.roles[data.guildId] ?? [], data.role),
        },
      });
    });

    client.on("ROLE_DELETE", (data) => {
      const current = get();
      const list = current.roles[data.guildId];
      if (list === undefined) return;
      // member_roles cascade ở DB → bỏ role khỏi chip của mọi thành viên.
      const members = current.members[data.guildId];
      set({
        roles: {
          ...current.roles,
          [data.guildId]: list.filter((role) => role.id !== data.roleId),
        },
        members:
          members === undefined
            ? current.members
            : {
                ...current.members,
                [data.guildId]: members.map((member) => ({
                  ...member,
                  roleIds: member.roleIds.filter((id) => id !== data.roleId),
                })),
              },
      });
    });

    // REST response và event realtime có thể về cùng lúc → luôn upsert theo id.
    client.on("CHANNEL_CREATE", (channel) => {
      if (channel.guildId === null) return;
      const current = get();
      set({
        channels: {
          ...current.channels,
          [channel.guildId]: upsertChannel(current.channels[channel.guildId] ?? [], channel),
        },
      });
    });

    client.on("CHANNEL_UPDATE", (channel) => {
      if (channel.guildId === null) return;
      const current = get();
      set({
        channels: {
          ...current.channels,
          [channel.guildId]: upsertChannel(current.channels[channel.guildId] ?? [], channel),
        },
      });
    });

    client.on("CHANNEL_DELETE", (data) => {
      const current = get();
      if (data.guildId === null) return;
      const list = current.channels[data.guildId] ?? [];
      const next = list.filter((channel) => channel.id !== data.id);
      const nextActive =
        current.activeChannelId === data.id
          ? pickChannel(next, undefined)
          : current.activeChannelId;
      set({
        channels: { ...current.channels, [data.guildId]: next },
        activeChannelId: nextActive,
      });
      if (nextActive !== null && nextActive !== current.activeChannelId) {
        void get().loadMessages(nextActive);
      }
    });

    client.connect();
  },

  selectGuild(guildId) {
    const channels = get().channels[guildId] ?? [];
    const channelId = pickChannel(channels, undefined);
    set({
      ...CLOSED_PINS,
      activeGuildId: guildId,
      activeChannelId: channelId,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
    });
    if (channelId !== null) get().markRead(channelId);
    if (channelId !== null && get().messages[channelId] === undefined) {
      void get().loadMessages(channelId);
    }
  },

  selectHome() {
    set({
      ...CLOSED_PINS,
      activeGuildId: null,
      activeChannelId: null,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
    });
  },

  async selectDm(channelId) {
    set({
      ...CLOSED_PINS,
      activeGuildId: null,
      activeChannelId: channelId,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
    });
    get().markRead(channelId);
    if (get().messages[channelId] === undefined) await get().loadMessages(channelId);
  },

  async openDm(recipientId) {
    try {
      const summary = await authedApi.createDm(recipientId);
      set({
      ...CLOSED_PINS,
        dms: upsertDm(get().dms, summary),
        activeGuildId: null,
        activeChannelId: summary.channel.id,
        mentionsOpen: false,
        settingsOpen: false,
        channelSettingsChannelId: null,
      });
      get().markRead(summary.channel.id);
      await get().loadMessages(summary.channel.id);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async selectChannel(channelId) {
    set({
      ...CLOSED_PINS,
      activeChannelId: channelId,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
    });
    get().markRead(channelId);
    if (get().messages[channelId] === undefined) await get().loadMessages(channelId);
  },

  async openMentions() {
    // Tải lại mỗi lần mở: quyền xem có thể vừa đổi và tin mới vẫn đang đến.
    set({
      mentionsOpen: true,
      settingsOpen: false,
      channelSettingsChannelId: null,
      mentionLoading: true,
    });
    try {
      const items = await authedApi.listMentions({ limit: MENTION_PAGE_SIZE });
      set({
        mentionItems: items,
        mentionLoading: false,
        mentionHasMore: items.length === MENTION_PAGE_SIZE,
      });
    } catch (error) {
      set({ mentionLoading: false, error: describeError(error) });
    }
  },

  openSearch() {
    set({
      searchOpen: true,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
      // Chưa chọn phạm vi thì mặc định tìm trong kênh đang mở.
      searchScope: get().activeChannelId === null ? "guild" : "channel",
    });
  },
  closeSearch() {
    set({ searchOpen: false });
  },
  setSearchQuery(query) {
    set({ searchQuery: query });
  },
  setSearchScope(scope) {
    set({ searchScope: scope, searchResults: null, searchHasMore: false });
  },
  async runSearch() {
    const { searchQuery, searchScope, activeChannelId, activeGuildId } = get();
    const query = searchQuery.trim();
    if (query.length < SEARCH_MIN_LENGTH) {
      set({ searchResults: [], searchHasMore: false, searchSubmittedFor: query });
      return;
    }
    const targetId = searchScope === "channel" ? activeChannelId : activeGuildId;
    if (targetId === null) return;

    set({ searchLoading: true, searchSubmittedFor: query });
    try {
      const page =
        searchScope === "channel"
          ? await authedApi.searchChannelMessages(targetId, query, { limit: SEARCH_PAGE_SIZE })
          : await authedApi.searchGuildMessages(targetId, query, { limit: SEARCH_PAGE_SIZE });
      set({
        searchResults: page,
        searchLoading: false,
        searchHasMore: page.length === SEARCH_PAGE_SIZE,
      });
    } catch (error) {
      set({ searchLoading: false, searchResults: [], searchHasMore: false, error: describeError(error) });
    }
  },
  async loadMoreSearch() {
    const current = get();
    const loaded = current.searchResults;
    const query = current.searchSubmittedFor;
    if (
      loaded === null ||
      loaded.length === 0 ||
      !current.searchHasMore ||
      current.searchLoading ||
      query.length < SEARCH_MIN_LENGTH
    ) {
      return;
    }
    const targetId = current.searchScope === "channel" ? current.activeChannelId : current.activeGuildId;
    if (targetId === null) return;

    const before = loaded[loaded.length - 1]!.message.id as string;
    set({ searchLoading: true });
    try {
      const page =
        current.searchScope === "channel"
          ? await authedApi.searchChannelMessages(targetId, query, {
              before,
              limit: SEARCH_PAGE_SIZE,
            })
          : await authedApi.searchGuildMessages(targetId, query, {
              before,
              limit: SEARCH_PAGE_SIZE,
            });
      // Tin mới có thể chen vào giữa hai lần tải → nối theo id đã có.
      const known = new Set((get().searchResults ?? []).map((hit) => hit.message.id as string));
      const merged = [...(get().searchResults ?? [])];
      for (const hit of page) {
        const id = hit.message.id as string;
        if (!known.has(id)) {
          known.add(id);
          merged.push(hit);
        }
      }
      set({
        searchResults: merged,
        searchLoading: false,
        searchHasMore: page.length === SEARCH_PAGE_SIZE,
      });
    } catch (error) {
      set({ searchLoading: false, error: describeError(error) });
    }
  },
  async openSearchHit(hit) {
    const channelId = hit.channel.id as string;
    set({
      searchOpen: false,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
      activeGuildId: hit.channel.guildId,
      activeChannelId: channelId,
    });
    get().markRead(channelId);

    await revealMessage(get, set, channelId, hit.message.id as string);
  },
  async loadMoreMentions() {
    const current = get();
    const loaded = current.mentionItems;
    if (
      loaded === null ||
      loaded.length === 0 ||
      !current.mentionHasMore ||
      current.mentionLoading
    ) {
      return;
    }
    const before = loaded[loaded.length - 1]!.message.id as string;
    set({ mentionLoading: true });
    try {
      const page = await authedApi.listMentions({ before, limit: MENTION_PAGE_SIZE });
      // Tin mới xen vào giữa hai lần tải có thể làm trùng id — nối theo id đã có.
      const known = new Set((get().mentionItems ?? []).map((item) => item.message.id as string));
      const merged = [...(get().mentionItems ?? [])];
      for (const item of page) {
        const id = item.message.id as string;
        if (!known.has(id)) {
          known.add(id);
          merged.push(item);
        }
      }
      set({
        mentionItems: merged,
        mentionLoading: false,
        mentionHasMore: page.length === MENTION_PAGE_SIZE,
      });
    } catch (error) {
      set({ mentionLoading: false, error: describeError(error) });
    }
  },

  closeMentions() {
    set({ mentionsOpen: false });
  },

  async jumpToMention(mention) {
    const channelId = mention.channel.id as string;
    set({
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
      activeGuildId: mention.channel.guildId,
      activeChannelId: channelId,
    });
    get().markRead(channelId);
    if (get().messages[channelId] === undefined) await get().loadMessages(channelId);
  },

  markRead(channelId) {
    const current = get();
    if (current.unread[channelId] === undefined && current.mentions[channelId] === undefined) {
      // Không có badge vẫn đồng bộ mốc đã đọc để thiết bị khác không thấy badge cũ.
      ackChannel(channelId);
      return;
    }
    const { [channelId]: _u, ...unread } = current.unread;
    const { [channelId]: _m, ...mentions } = current.mentions;
    set({ unread, mentions });
    ackChannel(channelId, undefined, true);
  },

  async loadMessages(channelId) {
    try {
      const newestFirst = await authedApi.listMessages(channelId, { limit: 50 });
      set({
        messages: {
          ...get().messages,
          [channelId]: [...newestFirst].reverse(),
        },
      });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async sendMessage(content, options = {}) {
    const channelId = get().activeChannelId;
    const files = options.files ?? [];
    // Tin chỉ có tệp (không text) vẫn hợp lệ.
    if (channelId === null) return false;
    if (content.trim().length === 0 && files.length === 0) return false;
    try {
      const message = await authedApi.sendMessage(channelId, content, {
        files,
        replyToId: options.replyToId,
      });
      const list = get().messages[channelId] ?? [];
      set({ messages: { ...get().messages, [channelId]: upsertMessage(list, message) } });
      // Mốc đã đọc tiến theo tin mình vừa gửi (các tab/thiết bị khác cũng vậy).
      ackChannel(channelId, message.id as string);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async editMessage(messageId, content) {
    const channelId = findChannelOf(get().messages, messageId);
    if (channelId === null) return false;
    try {
      const updated = await authedApi.editMessage(messageId, content);
      set({
        messages: {
          ...get().messages,
          [channelId]: upsertMessage(get().messages[channelId] ?? [], updated),
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async deleteMessage(messageId) {
    const current = get();
    const channelId = findChannelOf(current.messages, messageId);
    if (channelId === null) return false;
    try {
      await authedApi.deleteMessage(messageId);
      // Dòng trong tab Mentions cũng phải biến mất, nếu không bấm vào sẽ 404.
      set({
        messages: {
          ...current.messages,
          [channelId]: (current.messages[channelId] ?? []).filter(
            (message) => message.id !== messageId,
          ),
        },
        mentionItems:
          current.mentionItems === null
            ? null
            : current.mentionItems.filter((item) => item.message.id !== messageId),
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async createGuild(name) {
    try {
      const guild = await authedApi.createGuild(name);
      // READY đã chạy trước khi guild tồn tại nên phiên gateway chưa biết roles/
      // members/readStates của server mới. Identify lại để mọi thứ đi đúng một
      // đường (không tự ghép snapshot bằng tay), rồi nhảy sang server vừa tạo.
      gateway?.close();
      gateway = null;
      await get().connectGateway();
      get().selectGuild(guild.id);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async createChannel(name, type = "guild_text") {
    const guildId = get().activeGuildId;
    if (guildId === null) return;
    try {
      const channel = await authedApi.createChannel(guildId, { name, type });
      set({
        channels: {
          ...get().channels,
          [guildId]: upsertChannel(get().channels[guildId] ?? [], channel),
        },
        // Category chỉ nhóm sidebar, không có tin nhắn → không nhảy vào.
        ...(type === "guild_text" ? { activeChannelId: channel.id } : {}),
      });
      if (type === "guild_text") await get().loadMessages(channel.id);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async moveChannel(channelId, parentId) {
    try {
      const channel = await authedApi.editChannel(channelId, { parentId });
      const guildId = channel.guildId;
      if (guildId === null) return false;
      set({
        channels: {
          ...get().channels,
          [guildId]: upsertChannel(get().channels[guildId] ?? [], channel),
        },
      });
      // Category có overwrite → quyền hiệu dụng đổi; server đẩy PERMISSIONS_UPDATE.
      // Panel đang mở phải hiện đúng phần kế thừa của category mới.
      if (get().channelSettingsChannelId === channelId) {
        await get().openChannelSettings(channelId);
      }
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async reorderChannel(channelId, parentId, position) {
    try {
      const channel = await authedApi.editChannel(channelId, { parentId, position });
      const guildId = channel.guildId;
      if (guildId === null) return false;
      set({
        channels: {
          ...get().channels,
          [guildId]: upsertChannel(get().channels[guildId] ?? [], channel),
        },
      });
      // Kéo vào category khác → kế thừa đổi; panel đang mở phải hiện lại phần kế thừa.
      if (get().channelSettingsChannelId === channelId) {
        await get().openChannelSettings(channelId);
      }
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async copyInvite() {
    const { activeGuildId, activeChannelId } = get();
    if (activeGuildId === null || activeChannelId === null) return;
    try {
      const { code } = await authedApi.createInvite(activeGuildId, activeChannelId);
      await navigator.clipboard?.writeText(code).catch(() => undefined);
      set({ notice: code });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  openSettings() {
    set({ settingsOpen: true, mentionsOpen: false, channelSettingsChannelId: null });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  async createRole(input) {
    const guildId = get().activeGuildId;
    if (guildId === null) return null;
    try {
      const role = await authedApi.createRole(guildId, input);
      // Event ROLE_CREATE cũng về qua socket → upsert nên không bị nhân đôi.
      set({
        roles: {
          ...get().roles,
          [guildId]: upsertRole(get().roles[guildId] ?? [], role),
        },
      });
      return role;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async editRole(roleId, input) {
    const guildId = get().activeGuildId;
    if (guildId === null) return false;
    try {
      const role = await authedApi.editRole(guildId, roleId, input);
      set({
        roles: {
          ...get().roles,
          [guildId]: upsertRole(get().roles[guildId] ?? [], role),
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async reorderRole(roleId, position) {
    const guildId = get().activeGuildId;
    if (guildId === null) return false;
    try {
      const role = await authedApi.editRole(guildId, roleId, { position });
      set({
        roles: {
          ...get().roles,
          [guildId]: upsertRole(get().roles[guildId] ?? [], role),
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async deleteRole(roleId) {
    const guildId = get().activeGuildId;
    if (guildId === null) return false;
    try {
      await authedApi.deleteRole(guildId, roleId);
      const current = get();
      const members = current.members[guildId];
      set({
        roles: {
          ...current.roles,
          [guildId]: (current.roles[guildId] ?? []).filter((role) => role.id !== roleId),
        },
        members:
          members === undefined
            ? current.members
            : {
                ...current.members,
                [guildId]: members.map((member) => ({
                  ...member,
                  roleIds: member.roleIds.filter((id) => id !== roleId),
                })),
              },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async setMemberRole(memberId, roleId, assign) {
    const guildId = get().activeGuildId;
    if (guildId === null) return false;
    try {
      if (assign) await authedApi.addMemberRole(guildId, memberId, roleId);
      else await authedApi.removeMemberRole(guildId, memberId, roleId);
      // Cập nhật ngay; GUILD_MEMBER_UPDATE về sau chỉ ghi đè cùng giá trị.
      const members = get().members[guildId] ?? [];
      set({
        members: {
          ...get().members,
          [guildId]: members.map((member) => {
            if (member.userId !== memberId) return member;
            const roleIds = assign
              ? member.roleIds.includes(roleId as Snowflake)
                ? member.roleIds
                : [...member.roleIds, roleId as Snowflake]
              : member.roleIds.filter((id) => id !== roleId);
            return { ...member, roleIds };
          }),
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async createGroupDm(recipientIds, name) {
    set({ groupBusy: true });
    try {
      const summary = await authedApi.createGroupDm(recipientIds, name);
      set({
        dms: upsertDm(get().dms, summary),
        activeGuildId: null,
        activeChannelId: summary.channel.id,
        groupBusy: false,
        groupPanelOpen: false,
        mentionsOpen: false,
        settingsOpen: false,
        channelSettingsChannelId: null,
      });
      get().markRead(summary.channel.id);
      await get().loadMessages(summary.channel.id);
      return true;
    } catch (error) {
      set({ groupBusy: false, error: describeError(error) });
      return false;
    }
  },
  async addGroupMember(userId) {
    const channelId = get().activeChannelId;
    if (channelId === null) return false;
    set({ groupBusy: true });
    try {
      const summary = await authedApi.addGroupRecipient(channelId, userId);
      set({ dms: upsertDm(get().dms, summary), groupBusy: false });
      return true;
    } catch (error) {
      set({ groupBusy: false, error: describeError(error) });
      return false;
    }
  },
  async removeGroupMember(userId) {
    const channelId = get().activeChannelId;
    if (channelId === null) return false;
    set({ groupBusy: true });
    try {
      await authedApi.removeGroupRecipient(channelId, userId);
      // DM_CHANNEL_UPDATE của server sẽ gửi lại summary; cập nhật ngay tại chỗ
      // để danh sách không nhấp nháy chờ mạng.
      set({
        dms: get().dms.map((dm) =>
          dm.channel.id === channelId
            ? { ...dm, recipients: dm.recipients.filter((m) => m.userId !== userId) }
            : dm,
        ),
        groupBusy: false,
      });
      return true;
    } catch (error) {
      set({ groupBusy: false, error: describeError(error) });
      return false;
    }
  },
  async leaveGroupDm() {
    const channelId = get().activeChannelId;
    if (channelId === null) return false;
    set({ groupBusy: true });
    try {
      await authedApi.removeGroupRecipient(channelId, "@me");
      set({
        dms: get().dms.filter((dm) => dm.channel.id !== channelId),
        activeChannelId: null,
        activeGuildId: null,
        groupPanelOpen: false,
        groupBusy: false,
      });
      return true;
    } catch (error) {
      set({ groupBusy: false, error: describeError(error) });
      return false;
    }
  },
  async renameGroupDm(name) {
    const channelId = get().activeChannelId;
    if (channelId === null) return false;
    set({ groupBusy: true });
    try {
      const summary = await authedApi.renameGroupDm(channelId, name);
      set({ dms: upsertDm(get().dms, summary), groupBusy: false });
      return true;
    } catch (error) {
      set({ groupBusy: false, error: describeError(error) });
      return false;
    }
  },
  openGroupPanel() {
    set({ groupPanelOpen: true, pinsOpen: false, searchOpen: false, mentionsOpen: false });
  },
  closeGroupPanel() {
    set({ groupPanelOpen: false });
  },
  async openPins() {
    const channelId = get().activeChannelId;
    if (channelId === null) return;
    set({
      ...CLOSED_PINS,
      pinsOpen: true,
      pinsChannelId: channelId,
      pinsLoading: true,
      // Mỗi lúc chỉ một panel chiếm khung chính.
      mentionsOpen: false,
      searchOpen: false,
      settingsOpen: false,
      blocksOpen: false,
      channelSettingsChannelId: null,
    });
    try {
      const pins = await authedApi.listPinnedMessages(channelId);
      // Người dùng đổi kênh trong lúc chờ → bỏ kết quả cũ.
      if (get().pinsChannelId !== channelId) return;
      set({ pins, pinsLoading: false });
    } catch (error) {
      set({ pinsLoading: false, error: describeError(error) });
    }
  },
  closePins() {
    set({ pinsOpen: false });
  },
  async togglePin(messageId) {
    const channelId = get().activeChannelId;
    if (channelId === null) return false;
    const current = (get().messages[channelId] ?? []).find((message) => message.id === messageId);
    const pinned = current?.pinned ?? false;
    try {
      const updated = pinned
        ? await authedApi.unpinMessage(messageId)
        : await authedApi.pinMessage(messageId);
      // Cập nhật ngay; MESSAGE_PIN_UPDATE của chính mình về sau ghi đè cùng giá trị.
      set(patchMessage(get(), updated));
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async jumpToPinnedMessage(messageId) {
    const channelId = get().activeChannelId;
    if (channelId === null) return;
    set({ pinsOpen: false });
    await revealMessage(get, set, channelId, messageId);
  },
  async openBlocks() {
    set({
      blocksOpen: true,
      friendsOpen: false,
      searchOpen: false,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
      blocksLoading: true,
    });
    try {
      const blocks = await authedApi.listBlocks();
      set({ blocks, blocksLoading: false });
    } catch (error) {
      set({ blocksLoading: false, error: describeError(error) });
    }
  },
  closeBlocks() {
    set({ blocksOpen: false });
  },
  async blockUser(userId) {
    try {
      await authedApi.blockUser(userId);
      // DM với người vừa chặn bị server ẩn → bỏ khỏi sidebar ngay, không đợi tải lại.
      set({
        // Group DM chứa người vừa chặn vẫn phải còn: block là chuyện hai người,
        // không được làm cả nhóm biến mất (xem services/api/src/blocks.ts).
        dms: get().dms.filter((dm) => dmPeer(dm)?.userId !== userId),
        banner: { kind: "success", text: translate("userBlocked") },
        error: null,
      });
      if (get().blocksOpen) await get().openBlocks();
      else set({ blocks: null });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async unblockUser(userId) {
    try {
      await authedApi.unblockUser(userId);
      set({
        blocks: (get().blocks ?? []).filter((entry) => entry.userId !== userId),
        banner: { kind: "success", text: translate("userUnblocked") },
        error: null,
      });
      // Bỏ chặn thì DM cũ hiện lại; tải lại danh sách DM thay vì tự đoán.
      const dms = await authedApi.listDms();
      set({ dms });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  openReport(target) {
    set({ reportTarget: target, reportSending: false });
  },
  closeReport() {
    set({ reportTarget: null, reportSending: false });
  },
  async submitReport(input) {
    const target = get().reportTarget;
    if (target === null) return false;
    set({ reportSending: true });
    try {
      await authedApi.createReport({
        ...input,
        ...(target.messageId === undefined ? {} : { messageId: target.messageId }),
        ...(target.userId === undefined ? {} : { userId: target.userId }),
      });
      set({
        reportSending: false,
        reportTarget: null,
        banner: { kind: "success", text: translate("reportSent") },
        error: null,
      });
      return true;
    } catch (error) {
      set({ reportSending: false, error: describeError(error) });
      return false;
    }
  },
  async checkAdmin() {
    try {
      const { admin } = await authedApi.getAdminStatus();
      set({ admin });
      return admin;
    } catch {
      // Lỗi mạng/quyền không được làm hỏng app — coi như không phải admin.
      set({ admin: false });
      return false;
    }
  },
  async loadAdminReports(status) {
    const filter = status ?? get().adminStatusFilter;
    set({
      adminStatusFilter: filter,
      adminLoading: true,
      adminReports: filter === get().adminStatusFilter ? get().adminReports : null,
    });
    try {
      const page = await authedApi.listAdminReports({ status: filter, limit: ADMIN_PAGE_SIZE });
      set({
        adminReports: page.reports,
        adminCounts: page.counts,
        adminHasMore: page.hasMore,
        adminLoading: false,
      });
    } catch (error) {
      set({ adminLoading: false, adminReports: [], error: describeError(error) });
    }
  },
  async loadMoreAdminReports() {
    const loaded = get().adminReports;
    if (loaded === null || loaded.length === 0 || !get().adminHasMore || get().adminLoading) {
      return;
    }
    const before = loaded[loaded.length - 1]!.id as string;
    set({ adminLoading: true });
    try {
      const page = await authedApi.listAdminReports({
        status: get().adminStatusFilter,
        before,
        limit: ADMIN_PAGE_SIZE,
      });
      const known = new Set((get().adminReports ?? []).map((report) => report.id as string));
      const merged = [...(get().adminReports ?? [])];
      for (const report of page.reports) {
        if (!known.has(report.id as string)) merged.push(report);
      }
      set({
        adminReports: merged,
        adminCounts: page.counts,
        adminHasMore: page.hasMore,
        adminLoading: false,
      });
    } catch (error) {
      set({ adminLoading: false, error: describeError(error) });
    }
  },
  async updateReportStatus(reportId, status) {
    try {
      const updated = await authedApi.setReportStatus(reportId, status);
      const before = get().adminReports ?? [];
      const previous = before.find((report) => report.id === reportId);
      const filter = get().adminStatusFilter;

      // Dòng rời khỏi tab đang lọc (ví dụ đóng một báo cáo trong tab "open").
      const stillVisible = status === filter;
      const counts = get().adminCounts;
      set({
        adminReports: stillVisible
          ? before.map((report) => (report.id === reportId ? updated : report))
          : before.filter((report) => report.id !== reportId),
        // Cộng/trừ đúng chênh lệch: đổi sang chính trạng thái cũ không được đếm thêm.
        adminCounts:
          counts === null || previous === undefined || previous.status === status
            ? counts
            : {
                ...counts,
                [previous.status]: Math.max(0, counts[previous.status] - 1),
                [status]: counts[status] + 1,
              },
        error: null,
      });
      // Báo cáo không nằm trong trang đang giữ (vừa đổi từ tab khác) → đồng bộ lại.
      if (previous === undefined) await get().loadAdminReports();
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async uploadAvatar(file) {
    const invalid = validateAvatar(file);
    if (invalid !== null) {
      set({ avatarError: translate(invalid) });
      return false;
    }
    set({ avatarUploading: true, avatarError: null });
    try {
      const user = await authedApi.updateAvatar(file);
      // Cập nhật ngay ở client; `USER_UPDATE` về sau chỉ ghi đè cùng giá trị.
      set(applyProfile(get(), user));
      set({ avatarUploading: false });
      return true;
    } catch (error) {
      set({ avatarUploading: false, avatarError: describeError(error) });
      return false;
    }
  },
  async removeAvatar() {
    set({ avatarUploading: true, avatarError: null });
    try {
      const user = await authedApi.removeAvatar();
      set(applyProfile(get(), user));
      set({ avatarUploading: false });
      return true;
    } catch (error) {
      set({ avatarUploading: false, avatarError: describeError(error) });
      return false;
    }
  },
  clearAvatarError() {
    set({ avatarError: null });
  },
  async resendVerification() {
    try {
      const result = await authedApi.resendVerification();
      // Dev không có SMTP: server trả token để xác thực luôn, khỏi phải mở log.
      if (result.devVerificationToken !== undefined) {
        await get().verifyEmailToken(result.devVerificationToken);
        return;
      }
      set({
        banner: { kind: "success", text: translate("verificationResent") },
        error: null,
      });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      set({
        error: describeError(error),
        banner:
          apiError?.status === 429
            ? { kind: "error", text: apiError.message }
            : apiError?.status === 409
              ? { kind: "success", text: translate("emailAlreadyVerified") }
              : null,
      });
      if (apiError?.status === 409) {
        // Trạng thái thật đã đổi ở server (tab khác vừa xác thực) — đọc lại.
        await get().startSession().catch(() => undefined);
      }
    }
  },
  async verifyEmailToken(token) {
    try {
      const { user } = await api.verifyEmail(token);
      set({
        me: get().me === null ? get().me : { ...get().me!, emailVerified: user.emailVerified },
        banner: {
          kind: "success",
          text: user.emailVerified ? translate("emailVerified") : translate("emailVerifiedFailed"),
        },
        error: null,
      });
      return user.emailVerified;
    } catch (error) {
      set({
        banner: { kind: "error", text: translate("emailVerifiedFailed") },
        error: describeError(error),
      });
      return false;
    }
  },
  clearBanner() {
    set({ banner: null });
  },
  async toggleVoice(channelId) {
    const inChannel = get().voiceStates.some(
      (entry) => entry.channelId === channelId && entry.userId === get().me?.id,
    );
    try {
      if (inChannel) {
        // Cắt tiếng **trước** khi báo rời: rời chậm một nhịp cũng không được để
        // mic còn mở trong phòng mình đã rời.
        await stopVoiceAudio();
        set({ voiceAudio: null, voiceSpeakers: [] });
        await authedApi.leaveVoice(channelId);
      } else {
        await authedApi.joinVoice(channelId);
        // Không tự sửa `voiceStates` ở đây: server phát `VOICE_STATE_UPDATE` cho
        // chính mình, một nguồn sự thật duy nhất (tránh lệch khi bị từ chối).
        await startVoiceAudio(channelId, get, (patch) => set(patch));
      }
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
  async retryVoiceAudio() {
    const mine = get().voiceStates.find((entry) => entry.userId === get().me?.id);
    if (mine === undefined) return;
    await startVoiceAudio(mine.channelId as string, get, (patch) => set(patch));
  },
  async toggleVoiceMute() {
    const me = get().me;
    const self = get().voiceStates.find((entry) => entry.userId === me?.id);
    if (self === undefined) return;
    try {
      await authedApi.updateVoiceState(self.guildId, { selfMute: !self.selfMute });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
  async toggleVoiceDeafen() {
    const me = get().me;
    const self = get().voiceStates.find((entry) => entry.userId === me?.id);
    if (self === undefined) return;
    try {
      await authedApi.updateVoiceState(self.guildId, { selfDeaf: !self.selfDeaf });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
  async openFriends() {
    set({
      friendsOpen: true,
      blocksOpen: false,
      pinsOpen: false,
      searchOpen: false,
      groupPanelOpen: false,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
      friendsLoading: true,
      messageRequestsLoading: true,
    });
    try {
      // Tải song song: panel vẽ cả hai danh sách cùng lúc, không cần đợi nhau.
      const [friends, messageRequests] = await Promise.all([
        authedApi.listFriends(),
        authedApi.listMessageRequests(),
      ]);
      set({ friends, messageRequests, friendsLoading: false, messageRequestsLoading: false });
    } catch (error) {
      set({ friendsLoading: false, messageRequestsLoading: false, error: describeError(error) });
    }
  },
  closeFriends() {
    set({ friendsOpen: false });
  },
  setFriendQuery(query) {
    set({ friendQuery: query });
  },
  async addFriend(username) {
    try {
      const result = await authedApi.addFriend(username);
      // Kết quả có thể là "đã gửi lời mời" (có `createdAt`) hoặc "thành bạn luôn"
      // (khi người kia đã mời mình trước, có `since`). Cả hai đều thành công.
      set({ friendQuery: "", notice: translate("friendRequestSent", { username }) });
      if ("since" in result) await get().openFriends();
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async acceptFriend(userId) {
    try {
      await authedApi.acceptFriendRequest(userId);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async removeFriend(userId) {
    try {
      await authedApi.removeFriend(userId);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async setDmPrivacy(privacy) {
    try {
      const settings = await authedApi.updateSettings({ dmPrivacy: privacy });
      const current = get().friends;
      if (current !== null) set({ friends: { ...current, dmPrivacy: settings.dmPrivacy } });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async acceptMessageRequest(channelId) {
    try {
      const summary = await authedApi.acceptMessageRequest(channelId);
      set({
        messageRequests: get().messageRequests.filter((row) => row.channelId !== channelId),
        dms: upsertDm(get().dms, summary),
        friendsOpen: false,
      });
      // Mở luôn cuộc vừa duyệt: người dùng vừa bấm "Đồng ý" là muốn đọc nó.
      await get().selectDm(channelId);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async declineMessageRequest(channelId) {
    try {
      await authedApi.declineMessageRequest(channelId);
      set({
        messageRequests: get().messageRequests.filter((row) => row.channelId !== channelId),
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },
  async setDesktopNotifications(enabled) {
    if (!enabled) {
      applyNotificationSettings({ ...get().notificationSettings, desktop: false });
      return;
    }
    const permission = await requestNotificationPermission();
    const granted = permission === "granted";
    applyNotificationSettings({ ...get().notificationSettings, desktop: granted });
    set({ notificationPermission: permission });
  },
  setTabTitleNotifications(enabled) {
    applyNotificationSettings({ ...get().notificationSettings, tabTitle: enabled });
  },
  notifyTyping() {
    const channelId = get().activeChannelId;
    if (channelId === null) return;
    const now = Date.now();
    const last = typingSentAt.get(channelId) ?? 0;
    if (now - last < TYPING_THROTTLE_MS) return;
    typingSentAt.set(channelId, now);
    void authedApi.sendTyping(channelId).catch(() => undefined);
  },

  async openChannelSettings(channelId) {
    set({ channelSettingsChannelId: channelId, settingsOpen: false, mentionsOpen: false });
    try {
      const list = await authedApi.listOverwrites(channelId);
      const channels = get().channels[get().activeGuildId ?? ""] ?? [];
      const parentId = channels.find((channel) => channel.id === channelId)?.categoryId ?? null;
      // Kênh trong category: tải cả overwrite của category để panel hiện phần kế thừa.
      const inherited =
        parentId === null ? [] : await authedApi.listOverwrites(parentId);
      set({
        overwrites: {
          ...get().overwrites,
          [channelId]: list,
          ...(parentId === null ? {} : { [parentId]: inherited }),
        },
      });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  closeChannelSettings() {
    set({ channelSettingsChannelId: null });
  },

  async setOverwrite(channelId, targetType, targetId, allow, deny) {
    try {
      const saved = await authedApi.setOverwrite(channelId, targetType, targetId, {
        allow: serializePermissions(allow),
        deny: serializePermissions(deny),
      });
      const rest = (get().overwrites[channelId] ?? []).filter(
        (entry) => !(entry.targetType === targetType && entry.targetId === targetId),
      );
      set({
        overwrites: {
          ...get().overwrites,
          [channelId]: saved === null ? rest : [...rest, saved],
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async resetOverwrite(channelId, targetType, targetId) {
    try {
      await authedApi.deleteOverwrite(channelId, targetType, targetId);
      set({
        overwrites: {
          ...get().overwrites,
          [channelId]: (get().overwrites[channelId] ?? []).filter(
            (entry) => !(entry.targetType === targetType && entry.targetId === targetId),
          ),
        },
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  clearNotice() {
    set({ notice: null });
  },

  clearError() {
    set({ error: null });
  },
}));

/**
 * Tin nhắn có @gọi tên mình không? Username chứa `a-z0-9._-` nên cắt theo
 * đúng bộ ký tự đó, giống server (services/api/src/mentions.ts).
 */
function isMention(content: string, username: string | undefined): boolean {
  if (username === undefined || username.length === 0) return false;
  const target = username.toLowerCase();
  const pattern = /@([a-z0-9._-]{2,32})/gi;
  for (const match of content.matchAll(pattern)) {
    if ((match[1] ?? "").toLowerCase() === target) return true;
  }
  return false;
}

/** Parse map bitfield từ server một lần; bit hỏng chỉ mất quyền kênh đó. */
function parsePermissionMap(raw: Record<string, string>): Record<string, bigint> {
  const map: Record<string, bigint> = {};
  for (const [channelId, bits] of Object.entries(raw)) {
    try {
      map[channelId] = parsePermissions(bits);
    } catch {
      /* bỏ qua: coi như không có quyền ở kênh này */
    }
  }
  return map;
}

/** Kênh đang giữ tin này trong state (UI chỉ sửa/xoá tin đã tải về). */
function findChannelOf(messages: Record<string, Message[]>, messageId: string): string | null {
  for (const [channelId, list] of Object.entries(messages)) {
    if (list.some((message) => message.id === messageId)) return channelId;
  }
  return null;
}

function upsertRole(list: Role[], role: Role): Role[] {
  const exists = list.some((item) => item.id === role.id);
  const next = exists
    ? list.map((item) => (item.id === role.id ? role : item))
    : [...list, role];
  // Position giảm dần: mạnh nhất trước, giống Discord.
  return next.sort((a, b) => b.position - a.position || (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
}

function upsertChannel(list: Channel[], channel: Channel): Channel[] {
  const exists = list.some((item) => item.id === channel.id);
  const next = exists
    ? list.map((item) => (item.id === channel.id ? channel : item))
    : [...list, channel];
  return next.sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

function upsertDm(list: DmChannelSummary[], summary: DmChannelSummary): DmChannelSummary[] {
  const exists = list.some((item) => item.channel.id === summary.channel.id);
  const next = exists
    ? list.map((item) => (item.channel.id === summary.channel.id ? summary : item))
    : [...list, summary];
  // Mới nhất lên đầu — id snowflake tăng theo thời gian.
  return next.sort((a, b) => (BigInt(a.channel.id) < BigInt(b.channel.id) ? 1 : -1));
}

function pickChannel(channels: Channel[], preferred: string | undefined): string | null {
  if (preferred !== undefined && channels.some((channel) => channel.id === preferred)) {
    return preferred;
  }
  const text = channels.find(
    (channel) => channel.type === "guild_text" || channel.type === "dm" || channel.type === "group_dm",
  );
  return text?.id ?? null;
}

function upsertMessage(list: Message[], message: Message): Message[] {
  const index = list.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const next = [...list];
    next[index] = message;
    return next;
  }
  return [...list, message].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? error.message;
  }
  return error instanceof Error ? error.message : "Unknown error";
}
