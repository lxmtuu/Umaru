import type {
  Channel,
  ChannelOverwrite,
  DmChannelSummary,
  Guild,
  Message,
  MessageMention,
  ReadState,
  Role,
  User,
} from "@umaru/protocol";

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

export interface RegisterInput {
  username: string;
  displayName: string;
  email: string;
  password: string;
}

const API_PREFIX = "/api/v1";

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
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
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

  register(input: RegisterInput): Promise<AuthResult> {
    return this.request<AuthResult>(`${API_PREFIX}/auth/register`, {
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

  editRole(
    guildId: string,
    roleId: string,
    input: { name?: string; color?: number; permissions?: string },
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

  sendMessage(channelId: string, content: string, replyToId?: string): Promise<Message> {
    return this.request<Message>(`${API_PREFIX}/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, replyToId }),
    });
  }

  editMessage(messageId: string, content: string): Promise<Message> {
    return this.request<Message>(`${API_PREFIX}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
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
