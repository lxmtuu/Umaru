import type {
  Channel,
  ChannelOverwrite,
  DmChannelSummary,
  Guild,
  GuildMemberSummary,
  Message,
  MessageMention,
  PresenceStatus,
  Role,
  Snowflake,
  User,
} from "@umaru/protocol";
import { parsePermissions, serializePermissions } from "@umaru/protocol";
import { ApiError, GatewayClient, type GatewayState } from "@umaru/sdk";
import { create } from "zustand";
import { clearAttachmentCache } from "./attachments.js";
import { translate } from "./i18n.js";
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
  typing: Record<string, TypingEntry[]>;
  presence: Record<string, PresenceStatus>;
  error: string | null;
  notice: string | null;
  busy: boolean;

  boot(): Promise<void>;
  login(email: string, password: string): Promise<boolean>;
  register(input: {
    username: string;
    displayName: string;
    email: string;
    password: string;
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
  /** Xoá badge của kênh + báo server mốc đã đọc mới nhất. */
  markRead(channelId: string): void;
  loadMessages(channelId: string): Promise<void>;
  /** Gửi tin; `files` (không bắt buộc) đi kèm bằng multipart. */
  sendMessage(content: string, files?: File[]): Promise<boolean>;
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
  notifyTyping(): void;
  clearNotice(): void;
  clearError(): void;
}

let gateway: GatewayClient | null = null;
const typingSentAt = new Map<string, number>();
const TYPING_THROTTLE_MS = 7_000;
/** Số dòng mỗi trang của tab Mentions (server chặn tối đa 100). */
const MENTION_PAGE_SIZE = 50;
/** Tránh bắn POST /read theo từng tin khi kênh đang mở nhận tin liên tục. */
const ackedAt = new Map<string, number>();
const ACK_THROTTLE_MS = 3_000;

function ackChannel(channelId: string, messageId?: string, force = false): void {
  const now = Date.now();
  const last = ackedAt.get(channelId) ?? 0;
  if (!force && now - last < ACK_THROTTLE_MS) return;
  ackedAt.set(channelId, now);
  void authedApi.ackRead(channelId, messageId).catch(() => undefined);
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
  typing: {},
  presence: {},
  error: null,
  notice: null,
  busy: false,
};

export const useChat = create<ChatState>()((set, get) => ({
  ...initialState,

  async boot() {
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
    set({ ...initialState, screen: "auth" });
  },

  async startSession() {
    const me = await authedApi.getCurrentUser();
    set({ screen: "chat", me, error: null });
    await get().connectGateway();
  },

  async connectGateway() {
    const token = getAccessToken();
    if (token === null) throw new Error(translate("notSignedIn"));
    gateway?.close();

    const { url } = await api.getGatewayUrl();
    const client = new GatewayClient({ url, token });
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
        channels,
        members,
        roles,
        unread,
        mentions,
        permissions,
        activeGuildId: guildId,
        activeChannelId: channelId,
      });
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

    client.on("DM_CHANNEL_CREATE", (summary) => {
      // Chỉ thêm vào sidebar: không tự nhảy vào cuộc, không đụng badge của người nhận.
      set({ dms: upsertDm(get().dms, summary) });
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
      activeGuildId: null,
      activeChannelId: null,
      mentionsOpen: false,
      settingsOpen: false,
      channelSettingsChannelId: null,
    });
  },

  async selectDm(channelId) {
    set({
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

  async sendMessage(content, files = []) {
    const channelId = get().activeChannelId;
    // Tin chỉ có tệp (không text) vẫn hợp lệ.
    if (channelId === null) return false;
    if (content.trim().length === 0 && files.length === 0) return false;
    try {
      const message = await authedApi.sendMessage(channelId, content, { files });
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
