import { create } from "zustand";

/**
 * i18n tối giản — EN là default, VI chuyển được ngay (ROADMAP G1).
 * Mọi chuỗi UI phải đi qua `t()`, không hardcode trong component.
 */
const en = {
  appName: "Umaru",
  tagline: "Workspace for dev teams & study groups",
  login: "Log in",
  register: "Create account",
  email: "Email",
  password: "Password",
  username: "Username",
  displayName: "Display name",
  loginAction: "Log in",
  registerAction: "Create account",
  switchToRegister: "New here? Create an account",
  switchToLogin: "Already have an account? Log in",
  logout: "Log out",
  notSignedIn: "Not signed in",
  attachFile: "Attach file",
  attachHint: "Up to 4 files · 10 MB each",
  removeFile: "Remove {name}",
  filesTooMany: "Up to {count} files per message",
  fileTooLarge: "{name} is larger than 10 MB",
  fileTypeBlocked: "{name}: this file type is not allowed",
  downloadFile: "Download {name}",
  imageFailed: "Can't load {name}",
  dropToAttach: "Drop files to attach",
  attachmentOnly: "(attachment)",
  replyMessage: "Reply",
  replyingTo: "Replying to {name}",
  cancelReply: "Cancel reply",
  replyToMessage: "Reply to {name}",
  originalMessageUnavailable: "Original message is no longer available",
  loading: "Loading…",
  servers: "Servers",
  directMessages: "Direct messages",
  newMessage: "New message",
  noDms: "No direct messages yet — pick a server member to start.",
  noDmCandidates: "Join a server first to find people to message.",
  addServer: "Add a server",
  serverName: "Server name",
  create: "Create",
  cancel: "Cancel",
  addChannel: "Add channel",
  channelName: "Channel name",
  textChannel: "text",
  voiceChannel: "voice",
  invite: "Invite",
  inviteCopied: "Invite code copied: {code}",
  members: "Members",
  noChannel: "Pick a channel to start talking",
  noServers: "You're not in any server yet — create one.",
  messagePlaceholder: "Message #{channel}",
  dmPlaceholder: "Message @{name}",
  send: "Send",
  typingOne: "{name} is typing…",
  typingMany: "{count} people are typing…",
  emptyChannel: "No messages yet. Say hi!",
  edited: "(edited)",
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Offline",
  language: "Language",
  deleteMessage: "Delete",
  editMessage: "Edit",
  saveEdit: "Save",
  confirmDelete: "Delete?",
  you: "you",
  authFailed: "Could not sign in",
  genericError: "Something went wrong",
  online: "Online",
  offlineStatus: "Offline",
  sendFailed: "Message not sent",
  unread: "unread",
  mentionsBadge: "mentions",
  mentions: "Mentions",
  noMentions: "Nobody has mentioned you yet.",
  search: "Search messages",
  searchPlaceholder: "Search messages (at least 2 characters)",
  searchInChannel: "This channel",
  searchInGuild: "This server",
  searchEmpty: "Type at least 2 characters and press Enter.",
  searchNoResults: "No messages found.",
  searchTooMany: "Results are too many — refine the keyword.",
  searchResultCount: "{count} results",
  loadMore: "Load more",
  serverSettings: "Server settings",
  roles: "Roles",
  roleName: "Role name",
  roleColor: "Color",
  rolePermissions: "Permissions",
  newRole: "New role",
  save: "Save",
  selectRole: "Pick a role to edit",
  noRoles: "No roles yet — create one.",
  everyoneRoleHint: "Applied to every member, always.",
  assignRolesHint: "Toggle a role to give it to a member.",
  deleteRole: "Delete role",
  confirmDeleteRole: "Delete this role?",
  permViewChannel: "View channels",
  permSendMessages: "Send messages",
  permReadHistory: "Read history",
  permManageMessages: "Manage messages",
  permManageChannels: "Manage channels",
  permManageRoles: "Manage roles",
  permKickMembers: "Kick members",
  permBanMembers: "Ban members",
  permMentionEveryone: "Mention @everyone",
  permAdministrator: "Administrator",
  channelSettings: "Channel settings",
  overwrites: "Permission overrides",
  overwriteHint: "Allow/deny here overrides the server-wide role permissions for this channel only.",
  selectTarget: "Pick a role or member",
  allowPerm: "Allow",
  denyPerm: "Deny",
  inheritPerm: "Inherit",
  resetOverwrite: "Reset",
  noOverwrites: "No overrides yet.",
  cycleHint: "Click a permission to cycle inherit → allow → deny.",
  category: "Category",
  channelType: "Type",
  inheritedOverwrites: "Inherited from category",
  inheritedHint: "These come from the parent category and also apply here.",
  categoryOverwritesHint: "This is a category: overrides here apply to every channel inside it.",
  noCategory: "No category",
  newCategory: "New category",
  editCategory: "Edit category",
} as const;

export type MessageKey = keyof typeof en;

const vi: Record<MessageKey, string> = {
  appName: "Umaru",
  tagline: "Workspace cho dev & nhóm học",
  login: "Đăng nhập",
  register: "Tạo tài khoản",
  email: "Email",
  password: "Mật khẩu",
  username: "Tên người dùng",
  displayName: "Tên hiển thị",
  loginAction: "Đăng nhập",
  registerAction: "Tạo tài khoản",
  switchToRegister: "Chưa có tài khoản? Đăng ký",
  switchToLogin: "Đã có tài khoản? Đăng nhập",
  logout: "Đăng xuất",
  notSignedIn: "Chưa đăng nhập",
  attachFile: "Đính kèm tệp",
  attachHint: "Tối đa 4 tệp · 10 MB mỗi tệp",
  removeFile: "Bỏ {name}",
  filesTooMany: "Tối đa {count} tệp mỗi tin nhắn",
  fileTooLarge: "{name} vượt quá 10 MB",
  fileTypeBlocked: "{name}: định dạng này không được phép",
  downloadFile: "Tải {name}",
  imageFailed: "Không tải được {name}",
  dropToAttach: "Thả tệp để đính kèm",
  attachmentOnly: "(tệp đính kèm)",
  replyMessage: "Trả lời",
  replyingTo: "Đang trả lời {name}",
  cancelReply: "Huỷ trả lời",
  replyToMessage: "Trả lời {name}",
  originalMessageUnavailable: "Tin nhắn gốc không còn",
  loading: "Đang tải…",
  servers: "Server",
  directMessages: "Tin nhắn riêng",
  newMessage: "Tin nhắn mới",
  noDms: "Chưa có tin nhắn riêng — chọn một thành viên để bắt đầu.",
  noDmCandidates: "Hãy tham gia một server trước để tìm người nhắn.",
  addServer: "Thêm server",
  serverName: "Tên server",
  create: "Tạo",
  cancel: "Huỷ",
  addChannel: "Thêm kênh",
  channelName: "Tên kênh",
  textChannel: "văn bản",
  voiceChannel: "thoại",
  invite: "Mời",
  inviteCopied: "Đã copy mã mời: {code}",
  members: "Thành viên",
  noChannel: "Chọn một kênh để bắt đầu",
  noServers: "Bạn chưa ở server nào — hãy tạo một cái.",
  messagePlaceholder: "Nhắn vào #{channel}",
  dmPlaceholder: "Nhắn @{name}",
  send: "Gửi",
  typingOne: "{name} đang nhập…",
  typingMany: "{count} người đang nhập…",
  emptyChannel: "Chưa có tin nhắn. Chào một câu đi!",
  edited: "(đã sửa)",
  connected: "Đã kết nối",
  connecting: "Đang kết nối…",
  offline: "Mất kết nối",
  language: "Ngôn ngữ",
  deleteMessage: "Xoá",
  editMessage: "Sửa",
  saveEdit: "Lưu",
  confirmDelete: "Xoá?",
  you: "bạn",
  authFailed: "Không đăng nhập được",
  genericError: "Có lỗi xảy ra",
  online: "Trực tuyến",
  offlineStatus: "Ngoại tuyến",
  sendFailed: "Không gửi được tin nhắn",
  unread: "chưa đọc",
  mentionsBadge: "lượt nhắc",
  mentions: "Lượt nhắc",
  noMentions: "Chưa có ai nhắc bạn.",
  search: "Tìm tin nhắn",
  searchPlaceholder: "Tìm tin nhắn (ít nhất 2 ký tự)",
  searchInChannel: "Kênh này",
  searchInGuild: "Server này",
  searchEmpty: "Gõ ít nhất 2 ký tự rồi nhấn Enter.",
  searchNoResults: "Không tìm thấy tin nhắn nào.",
  searchTooMany: "Kết quả quá nhiều — thêm từ khoá cho cụ thể hơn.",
  searchResultCount: "{count} kết quả",
  loadMore: "Xem thêm",
  serverSettings: "Cài đặt server",
  roles: "Role",
  roleName: "Tên role",
  roleColor: "Màu",
  rolePermissions: "Quyền",
  newRole: "Role mới",
  save: "Lưu",
  selectRole: "Chọn một role để sửa",
  noRoles: "Chưa có role nào — tạo một cái.",
  everyoneRoleHint: "Luôn áp dụng cho mọi thành viên.",
  assignRolesHint: "Bấm để gán/thu role cho thành viên.",
  deleteRole: "Xoá role",
  confirmDeleteRole: "Xoá role này?",
  permViewChannel: "Xem kênh",
  permSendMessages: "Gửi tin nhắn",
  permReadHistory: "Đọc lịch sử",
  permManageMessages: "Quản lý tin nhắn",
  permManageChannels: "Quản lý kênh",
  permManageRoles: "Quản lý role",
  permKickMembers: "Kick thành viên",
  permBanMembers: "Ban thành viên",
  permMentionEveryone: "Nhắc @everyone",
  permAdministrator: "Quản trị viên",
  channelSettings: "Cài đặt kênh",
  overwrites: "Ghi đè quyền",
  overwriteHint: "Cho phép/từ chối ở đây đè lên quyền role của server, chỉ cho kênh này.",
  selectTarget: "Chọn role hoặc thành viên",
  allowPerm: "Cho phép",
  denyPerm: "Từ chối",
  inheritPerm: "Theo role",
  resetOverwrite: "Đặt lại",
  noOverwrites: "Chưa có ghi đè nào.",
  cycleHint: "Bấm một quyền để chuyển theo role → cho phép → từ chối.",
  category: "Danh mục",
  channelType: "Loại",
  inheritedOverwrites: "Kế thừa từ danh mục",
  inheritedHint: "Những mục này đến từ danh mục cha và cũng áp cho kênh này.",
  categoryOverwritesHint: "Đây là danh mục: ghi đè ở đây áp cho mọi kênh bên trong.",
  noCategory: "Không có danh mục",
  newCategory: "Danh mục mới",
  editCategory: "Sửa danh mục",
};

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, vi };

export type Locale = "en" | "vi";

const LOCALE_KEY = "umaru.locale";

function initialLocale(): Locale {
  try {
    // Đọc có thể ném lỗi khi storage bị chặn (iframe khác site, chế độ riêng tư).
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_KEY);
    return stored === "vi" ? "vi" : "en";
  } catch {
    return "en";
  }
}

interface LocaleState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: initialLocale(),
  setLocale(locale) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      /* storage bị chặn: chỉ đổi trong phiên này */
    }
    set({ locale });
  },
}));

function format(key: MessageKey, locale: Locale, vars?: Record<string, string | number>): string {
  let text: string = dictionaries[locale][key] ?? en[key];
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const locale = useLocale((state) => state.locale);
  return (key, vars) => format(key, locale, vars);
}

/** Dùng ngoài React (store, SDK wrapper) — vẫn theo locale đang chọn, không hardcode. */
export function translate(key: MessageKey, vars?: Record<string, string | number>): string {
  return format(key, useLocale.getState().locale, vars);
}
