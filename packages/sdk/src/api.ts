import type {
  AdminReport,
  AdminReportPage,
  Channel,
  ChannelOverwrite,
  DmChannelSummary,
  Guild,
  Message,
  MessageMention,
  MessageSearchHit,
  ReportInput,
  ReportResult,
  ReportStatus,
  ReadState,
  Role,
  User,
  GuildMemberSummary,
  VoiceState,
  FriendList,
  FriendSummary,
  FriendRequestSummary,
  MessageRequestSummary,
  UserSettings,
} from "@umaru/protocol";

function buildSearchParams(query: string, options: { before?: string; limit?: number }): string {
  const params = new URLSearchParams({ q: query });
  if (options.before !== undefined) params.set("before", options.before);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return `?${params.toString()}`;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  /** Ví dụ https://api.umaru.dev — để trống "" khi gọi same-origin (dev qua Vite proxy). */
  baseUrl: string;
  /** Getter vì token đổi được khi login/logout. */
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

/** Kết quả đăng ký: như `AuthResult`, kèm dấu hiệu đã gửi mail xác thực. */
export interface RegisterResult extends AuthResult {
  emailVerificationSent?: boolean;
  /** Chỉ có ở dev/test (`EMAIL_VERIFICATION_ECHO`) — production không trả về. */
  devVerificationToken?: string;
}

export interface ResendVerificationResult {
  sent: boolean;
  devVerificationToken?: string;
}

export interface RegisterInput {
  username: string;
  displayName: string;
  email: string;
  password: string;
  /**
   * Đồng ý Điều khoản & Chính sách quyền riêng tư — server **bắt buộc** `true`,
   * nên để required ở đây để không quên khi gọi.
   */
  acceptedTerms: true;
}

const API_PREFIX = "/api/v1";

function isFormData(value: unknown): boolean {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

/** REST client — phản chiếu services/api. Mọi path tính từ gốc API. */
export class UmaruApi {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const token = this.getToken();
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        // Chỉ khai content-type khi thực sự có body: Fastify từ chối
        // `content-type: application/json` mà body rỗng (typing, DELETE...).
        // FormData phải để trình duyệt tự đặt kèm `boundary`.
        ...(init.body !== undefined && !isFormData(init.body)
          ? { "content-type": "application/json" }
          : {}),
        // Gửi token ở cả hai header: `Authorization` là chuẩn, `x-umaru-token`
        // là đường dự phòng vì nhiều reverse proxy bỏ header `Authorization`
        // (xem services/api/src/auth/guard.ts).
        ...(token !== null
          ? { authorization: `Bearer ${token}`, "x-umaru-token": token }
          : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      throw new ApiError(response.status, `API ${path} thất bại: ${response.status}`, body);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  // ---------- auth ----------

  register(input: RegisterInput): Promise<RegisterResult> {
    return this.request<RegisterResult>(`${API_PREFIX}/auth/register`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  login(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>(`${API_PREFIX}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  refresh(refreshToken: string): Promise<AuthResult> {
    return this.request<AuthResult>(`${API_PREFIX}/auth/refresh`, {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  }

  /** Xác thực email bằng token trong link (không cần đăng nhập). */
  verifyEmail(token: string): Promise<{ user: User }> {
    return this.request<{ user: User }>(`${API_PREFIX}/auth/verify-email`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }

  /** Gửi lại mail xác thực (cần đăng nhập; server có cooldown). */
  resendVerification(): Promise<ResendVerificationResult> {
    return this.request<ResendVerificationResult>(`${API_PREFIX}/auth/verify-email/resend`, {
      method: "POST",
    });
  }

  /** Danh sách người tôi đã chặn. */
  listBlocks(): Promise<GuildMemberSummary[]> {
    return this.request<GuildMemberSummary[]>(`${API_PREFIX}/users/@me/blocks`);
  }

  /** Chặn một người (idempotent). Chặn cắt DM cả hai chiều. */
  blockUser(userId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/users/@me/blocks/${userId}`, { method: "PUT" });
  }

  unblockUser(userId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/users/@me/blocks/${userId}`, { method: "DELETE" });
  }

  /** Gửi báo cáo vi phạm: `messageId` (một tin) hoặc `userId` (một người). */
  createReport(input: ReportInput): Promise<ReportResult> {
    return this.request<ReportResult>(`${API_PREFIX}/reports`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Người vận hành nền tảng: xem hàng đợi báo cáo vi phạm.
   * Thiếu quyền → `ApiError` 403 (client ẩn lối vào, nhưng quyền luôn kiểm ở server).
   */
  getAdminStatus(): Promise<{ admin: boolean }> {
    return this.request<{ admin: boolean }>(`${API_PREFIX}/admin/status`);
  }

  listAdminReports(
    options: { status?: ReportStatus; before?: string; limit?: number } = {},
  ): Promise<AdminReportPage> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.before !== undefined) params.set("before", options.before);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<AdminReportPage>(`${API_PREFIX}/admin/reports${query}`);
  }

  setReportStatus(reportId: string, status: ReportStatus): Promise<AdminReport> {
    return this.request<AdminReport>(`${API_PREFIX}/admin/reports/${reportId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  logout(refreshToken: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/auth/logout`, {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  }

  // ---------- user / guild ----------

  /** URL websocket gateway. */
  getGatewayUrl(): Promise<{ url: string; version: number }> {
    return this.request<{ url: string; version: number }>(`${API_PREFIX}/gateway`);
  }

  getCurrentUser(): Promise<User> {
    return this.request<User>(`${API_PREFIX}/users/@me`);
  }

  listGuilds(): Promise<Guild[]> {
    return this.request<Guild[]>(`${API_PREFIX}/users/@me/guilds`);
  }

  createGuild(name: string): Promise<Guild> {
    return this.request<Guild>(`${API_PREFIX}/guilds`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  listChannels(guildId: string): Promise<Channel[]> {
    return this.request<Channel[]>(`${API_PREFIX}/guilds/${guildId}/channels`);
  }

  createChannel(
    guildId: string,
    input: { name: string; type?: Channel["type"]; parentId?: string | null },
  ): Promise<Channel> {
    return this.request<Channel>(`${API_PREFIX}/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Sửa tên/topic và **category chứa kênh**. `parentId: null` = đưa ra gốc;
   * bỏ trống = giữ nguyên. Đổi category làm quyền hiệu dụng thay đổi theo.
   */
  /**
   * Sửa kênh. `parentId: null` đưa ra gốc; `position` là chỉ số trong nhóm kênh cùng
   * category (kéo-thả) — server renumber lại anh em rồi trả về thứ tự mới.
   */
  editChannel(
    channelId: string,
    input: {
      name?: string;
      topic?: string | null;
      parentId?: string | null;
      position?: number;
    },
  ): Promise<Channel> {
    return this.request<Channel>(`${API_PREFIX}/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  // ---------- DM 1-1 ----------

  listDms(): Promise<DmChannelSummary[]> {
    return this.request<DmChannelSummary[]>(`${API_PREFIX}/users/@me/channels`);
  }

  /** Mở hoặc lấy lại DM 1-1. Trả 201 khi tạo mới, 200 nếu đã có. */
  createDm(recipientId: string): Promise<DmChannelSummary> {
    return this.request<DmChannelSummary>(`${API_PREFIX}/users/@me/channels`, {
      method: "POST",
      body: JSON.stringify({ recipientId }),
    });
  }

  /** Tạo group DM mới với 2–9 người khác (tối đa 10 người tính cả mình). */
  createGroupDm(recipientIds: string[], name?: string): Promise<DmChannelSummary> {
    return this.request<DmChannelSummary>(`${API_PREFIX}/users/@me/channels`, {
      method: "POST",
      body: JSON.stringify(name === undefined ? { recipientIds } : { recipientIds, name }),
    });
  }

  /** Thêm người vào group DM (mọi thành viên đều mời được). */
  addGroupRecipient(channelId: string, userId: string): Promise<DmChannelSummary> {
    return this.request<DmChannelSummary>(`${API_PREFIX}/channels/${channelId}/recipients`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  /** Rời nhóm (`userId` = "@me") hoặc mời người khác ra (chỉ chủ nhóm). */
  removeGroupRecipient(channelId: string, userId: string): Promise<void> {
    return this.request<void>(
      `${API_PREFIX}/channels/${channelId}/recipients/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  /** Đổi tên nhóm; `null`/rỗng = bỏ tên, quay lại ghép tên thành viên. */
  renameGroupDm(channelId: string, name: string | null): Promise<DmChannelSummary> {
    return this.request<DmChannelSummary>(`${API_PREFIX}/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  createInvite(guildId: string, channelId: string): Promise<{ code: string }> {
    return this.request<{ code: string }>(`${API_PREFIX}/guilds/${guildId}/invites`, {
      method: "POST",
      body: JSON.stringify({ channelId }),
    });
  }

  acceptInvite(code: string): Promise<Guild> {
    return this.request<Guild>(`${API_PREFIX}/invites/${code}`, { method: "POST" });
  }

  // ---------- roles ----------

  listRoles(guildId: string): Promise<Role[]> {
    return this.request<Role[]>(`${API_PREFIX}/guilds/${guildId}/roles`);
  }

  /**
   * Tạo role (cần `MANAGE_ROLES`). `permissions` là bitfield thập phân
   * (`serializePermissions()`); quyền cấp ra phải nằm trong quyền của bạn.
   */
  createRole(
    guildId: string,
    input: { name: string; color?: number; permissions?: string },
  ): Promise<Role> {
    return this.request<Role>(`${API_PREFIX}/guilds/${guildId}/roles`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Sửa role. `position` là **thứ hạng kéo-thả** (0 = trên cùng, không tính
   * `@everyone`) — server renumber lại cả dãy và phát `ROLE_UPDATE` cho những
   * role đổi chỗ.
   */
  editRole(
    guildId: string,
    roleId: string,
    input: { name?: string; color?: number; permissions?: string; position?: number },
  ): Promise<Role> {
    return this.request<Role>(`${API_PREFIX}/guilds/${guildId}/roles/${roleId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  deleteRole(guildId: string, roleId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/guilds/${guildId}/roles/${roleId}`, {
      method: "DELETE",
    });
  }

  /** Gán role cho thành viên (204). Trả 403 nếu role cao hơn cấp của bạn hoặc quyền của role ngoài tầm. */
  addMemberRole(guildId: string, memberId: string, roleId: string): Promise<void> {
    return this.request<void>(
      `${API_PREFIX}/guilds/${guildId}/members/${memberId}/roles/${roleId}`,
      { method: "PUT" },
    );
  }

  removeMemberRole(guildId: string, memberId: string, roleId: string): Promise<void> {
    return this.request<void>(
      `${API_PREFIX}/guilds/${guildId}/members/${memberId}/roles/${roleId}`,
      { method: "DELETE" },
    );
  }

  // ---------- ghi đè quyền theo kênh ----------

  /** Cần `MANAGE_CHANNELS` hoặc `MANAGE_ROLES` — thành viên thường nhận 403. */
  listOverwrites(channelId: string): Promise<ChannelOverwrite[]> {
    return this.request<ChannelOverwrite[]>(`${API_PREFIX}/channels/${channelId}/overwrites`);
  }

  /**
   * Đặt ghi đè quyền cho một role/thành viên tại kênh. `allow`/`deny` là bitfield
   * thập phân (`serializePermissions()`) và không được giao nhau. Trả `null` khi
   * cả hai bằng 0: server xoá dòng, target trở về kế thừa quyền role.
   */
  setOverwrite(
    channelId: string,
    targetType: "role" | "member",
    targetId: string,
    input: { allow: string; deny: string },
  ): Promise<ChannelOverwrite | null> {
    return this.request<ChannelOverwrite | null>(
      `${API_PREFIX}/channels/${channelId}/overwrites/${targetType}/${targetId}`,
      { method: "PUT", body: JSON.stringify(input) },
    ).then((value) => value ?? null);
  }

  deleteOverwrite(
    channelId: string,
    targetType: "role" | "member",
    targetId: string,
  ): Promise<void> {
    return this.request<void>(
      `${API_PREFIX}/channels/${channelId}/overwrites/${targetType}/${targetId}`,
      { method: "DELETE" },
    );
  }

  // ---------- message ----------

  listMessages(
    channelId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<Message[]> {
    const params = new URLSearchParams();
    if (options.before !== undefined) params.set("before", options.before);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<Message[]>(`${API_PREFIX}/channels/${channelId}/messages${query}`);
  }

  /**
   * Tìm tin nhắn trong một kênh (kênh server hoặc DM).
   * `q` tối thiểu 2 ký tự; kết quả mới nhất trước, phân trang bằng `before`.
   */
  searchChannelMessages(
    channelId: string,
    query: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<MessageSearchHit[]> {
    return this.request<MessageSearchHit[]>(
      `${API_PREFIX}/channels/${channelId}/messages/search${buildSearchParams(query, options)}`,
    );
  }

  /** Tìm tin nhắn trong toàn server (chỉ những kênh user được xem). */
  searchGuildMessages(
    guildId: string,
    query: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<MessageSearchHit[]> {
    return this.request<MessageSearchHit[]>(
      `${API_PREFIX}/guilds/${guildId}/messages/search${buildSearchParams(query, options)}`,
    );
  }

  /**
   * Gửi tin. Có `files` → dùng `multipart/form-data` (cùng đường dẫn API); không
   * có file → JSON như cũ. Tham số thứ ba nhận cả chuỗi `replyToId` (kiểu cũ)
   * lẫn object tuỳ chọn để không phải sửa mọi chỗ gọi.
   */
  sendMessage(
    channelId: string,
    content: string,
    options: string | { replyToId?: string; files?: File[] } = {},
  ): Promise<Message> {
    const settings = typeof options === "string" ? { replyToId: options } : options;
    const path = `${API_PREFIX}/channels/${channelId}/messages`;

    if (settings.files !== undefined && settings.files.length > 0) {
      const form = new FormData();
      if (content.length > 0) form.set("content", content);
      if (settings.replyToId !== undefined && settings.replyToId !== "") {
        form.set("replyToId", settings.replyToId);
      }
      for (const file of settings.files) {
        form.append("files", file, file.name);
      }
      return this.request<Message>(path, { method: "POST", body: form });
    }

    return this.request<Message>(path, {
      method: "POST",
      body: JSON.stringify({ content, replyToId: settings.replyToId }),
    });
  }

  editMessage(messageId: string, content: string): Promise<Message> {
    return this.request<Message>(`${API_PREFIX}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  /**
   * Tải nội dung tệp đính kèm. Trả `Blob` để client tự dựng object URL —
   * không đặt token vào query string / `<img src>` (tránh lộ token qua log,
   * referrer, cache của trình duyệt).
   */
  async fetchAttachment(attachmentId: string): Promise<Blob> {
    const url = `${this.baseUrl}${API_PREFIX}/attachments/${attachmentId}`;
    const token = this.getToken();
    const response = await this.fetchImpl(url, {
      headers:
        token !== null
          ? { authorization: `Bearer ${token}`, "x-umaru-token": token }
          : {},
    });
    if (!response.ok) {
      throw new ApiError(response.status, `API ${url} thất bại: ${response.status}`);
    }
    return response.blob();
  }

  /**
   * Đặt ảnh đại diện. Dùng `FormData` để trình duyệt tự đặt `boundary` —
   * **không** tự gắn `content-type`.
   */
  updateAvatar(file: File): Promise<User> {
    const form = new FormData();
    form.append("file", file, file.name);
    return this.request<User>(`${API_PREFIX}/users/@me/avatar`, { method: "PUT", body: form });
  }

  /** Gỡ ảnh đại diện (quay lại chữ cái đầu). */
  removeAvatar(): Promise<User> {
    return this.request<User>(`${API_PREFIX}/users/@me/avatar`, { method: "DELETE" });
  }

  /**
   * Tải nội dung avatar. Nhận đúng giá trị `User.avatarUrl`
   * (`/api/v1/users/:id/avatar/:uploadId`). Trả `Blob` để client dựng object
   * URL — không đặt token vào URL.
   */
  async fetchAvatar(avatarUrl: string): Promise<Blob> {
    const url = avatarUrl.startsWith("http")
      ? avatarUrl
      : `${this.baseUrl}${avatarUrl}`;
    const token = this.getToken();
    const response = await this.fetchImpl(url, {
      headers:
        token !== null ? { authorization: `Bearer ${token}`, "x-umaru-token": token } : {},
    });
    if (!response.ok) {
      throw new ApiError(response.status, `API ${url} thất bại: ${response.status}`);
    }
    return response.blob();
  }

  /**
   * Ghim một tin (cần `MANAGE_MESSAGES` trong server; DM ai trong cuộc cũng
   * ghim được). Trả về tin sau khi ghim (`pinned: true`).
   */
  pinMessage(messageId: string): Promise<Message> {
    return this.request<Message>(`${API_PREFIX}/messages/${messageId}/pin`, { method: "PUT" });
  }

  /** Bỏ ghim (idempotent). */
  unpinMessage(messageId: string): Promise<Message> {
    return this.request<Message>(`${API_PREFIX}/messages/${messageId}/pin`, {
      method: "DELETE",
    });
  }

  /** Danh sách tin đã ghim của kênh, mới ghim trước (tối đa 50). */
  listPinnedMessages(channelId: string, limit?: number): Promise<Message[]> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    return this.request<Message[]>(`${API_PREFIX}/channels/${channelId}/pins${query}`);
  }

  /**
   * Vào phòng thoại của kênh voice (idempotent; đổi kênh thì tự rời kênh cũ).
   * Chưa truyền âm thanh — đây là lớp trạng thái "ai đang ở phòng nào".
   */
  joinVoice(channelId: string): Promise<VoiceState> {
    return this.request<VoiceState>(`${API_PREFIX}/channels/${channelId}/voice`, {
      method: "PUT",
    });
  }

  /** Rời phòng thoại (idempotent). */
  leaveVoice(channelId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/channels/${channelId}/voice`, { method: "DELETE" });
  }

  /** Tự mute/deafen trong phòng thoại đang ở. */
  updateVoiceState(
    guildId: string,
    patch: { selfMute?: boolean; selfDeaf?: boolean },
  ): Promise<VoiceState> {
    return this.request<VoiceState>(`${API_PREFIX}/guilds/${guildId}/voice-state`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Bạn bè + lời mời (hai chiều) + quyền riêng tư DM của mình. */
  listFriends(): Promise<FriendList> {
    return this.request<FriendList>(`${API_PREFIX}/users/@me/friends`);
  }

  /**
   * Gửi lời mời kết bạn bằng `username`. Nếu người kia đã mời mình trước thì
   * lời gọi này **đồng ý luôn** (server trả `FriendSummary` thay vì lời mời).
   */
  addFriend(username: string): Promise<FriendRequestSummary | FriendSummary> {
    return this.request<FriendRequestSummary | FriendSummary>(`${API_PREFIX}/users/@me/friends`, {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  }

  /** Yêu cầu nhắn tin đang chờ mình duyệt (người lạ mở DM khi mình đặt "chỉ bạn bè"). */
  listMessageRequests(): Promise<MessageRequestSummary[]> {
    return this.request<MessageRequestSummary[]>(`${API_PREFIX}/users/@me/message-requests`);
  }

  /** Đồng ý → cuộc trò chuyện thành DM bình thường (trả summary để client mở luôn). */
  acceptMessageRequest(channelId: string): Promise<DmChannelSummary> {
    return this.request<DmChannelSummary>(
      `${API_PREFIX}/users/@me/message-requests/${channelId}/accept`,
      { method: "POST" },
    );
  }

  /** Từ chối → cuộc trò chuyện bị xoá với cả hai bên (không giữ nội dung). */
  declineMessageRequest(channelId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/users/@me/message-requests/${channelId}/decline`, {
      method: "POST",
    });
  }

  acceptFriendRequest(userId: string): Promise<FriendSummary> {
    return this.request<FriendSummary>(`${API_PREFIX}/users/@me/friends/${userId}/accept`, {
      method: "POST",
    });
  }

  /** Huỷ kết bạn / từ chối lời mời / huỷ lời mời đã gửi (idempotent). */
  removeFriend(userId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/users/@me/friends/${userId}`, { method: "DELETE" });
  }

  updateSettings(patch: { dmPrivacy?: "everyone" | "friends" }): Promise<UserSettings> {
    return this.request<UserSettings>(`${API_PREFIX}/users/@me/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteMessage(messageId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/messages/${messageId}`, { method: "DELETE" });
  }

  /** Đánh dấu đã đọc tới `messageId` (bỏ trống = tin mới nhất của kênh). */
  ackRead(channelId: string, messageId?: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/channels/${channelId}/read`, {
      method: "POST",
      body: JSON.stringify(messageId !== undefined ? { messageId } : {}),
    });
  }

  listReadStates(): Promise<ReadState[]> {
    return this.request<ReadState[]>(`${API_PREFIX}/users/@me/read-states`);
  }

  /**
   * Tab Mentions: tin có @gọi mình, mới nhất trước. Phân trang bằng `before`
   * (id tin cuối cùng đã nhận). Server đã lọc theo quyền xem hiện tại.
   */
  listMentions(options: { before?: string; limit?: number } = {}): Promise<MessageMention[]> {
    const params = new URLSearchParams();
    if (options.before !== undefined) params.set("before", options.before);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<MessageMention[]>(`${API_PREFIX}/users/@me/mentions${query}`);
  }

  sendTyping(channelId: string): Promise<void> {
    return this.request<void>(`${API_PREFIX}/channels/${channelId}/typing`, { method: "POST" });
  }
}
