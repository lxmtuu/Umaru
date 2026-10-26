import type {
  Channel,
  GuildMemberSummary,
  Message,
  MessageMention,
  MessageSearchHit,
  VoiceState,
} from "@umaru/protocol";
import { Permission, hasPermission } from "@umaru/protocol";
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import {
  formatBytes,
  MAX_FILES_PER_MESSAGE,
  validateFiles,
} from "../lib/attachments.js";
import { SEARCH_MIN_LENGTH, useChat, type SearchScope } from "../lib/chatStore.js";
import { translate, useLocale, useT } from "../lib/i18n.js";
import { ChannelSettings } from "./ChannelSettings.js";
import { MessageAttachments } from "./MessageAttachments.js";
import { MemberList } from "./MemberList.js";
import { MessageContent } from "./MessageContent.js";
import { legalPath } from "../lib/legalRoute.js";
import { buildTimeline, dividerLabel } from "../lib/messageTimeline.js";
import { resultText, snippetAround, splitHighlight } from "../lib/search.js";
import { dmAvatarUrl, dmInitial, dmPeer, dmTitle, isGroupDm } from "../lib/dms.js";
import { Avatar } from "./Avatar.js";
import { GroupDmPanel } from "./GroupDmPanel.js";
import { ProfileDialog } from "./ProfileDialog.js";
import { RoleSettings } from "./RoleSettings.js";
import { type DropTarget, resolveDrop } from "../lib/channelDrop.js";
import { isSpeaking } from "../lib/voice.js";
import { PRESENCE_DOT, presenceOf } from "../lib/presence.js";
import { VoiceBar } from "./VoiceBar.js";
import { VoiceScreens } from "./VoiceScreens.js";
import { FriendsPanel } from "./FriendsPanel.js";
import { formatTabTitle } from "../lib/notifications.js";
import { BlocksPanel, ReportDialog } from "./SafetyPanels.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { copyToClipboard } from "../lib/clipboard.js";

export function ChatScreen() {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const state = useChat();

  const [draft, setDraft] = useState("");
  /** Tệp chờ gửi kèm tin kế tiếp (tối đa 4, kiểm ở lib/attachments). */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Tin đang được trả lời (thanh nhắc trên ô soạn). */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showCreateGuild, setShowCreateGuild] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  /** Hộp thoại hồ sơ (đổi ảnh đại diện). */
  const [showProfile, setShowProfile] = useState(false);
  /** Người đang được chọn trong hộp thoại "Tin nhắn mới" (≥2 → tạo nhóm). */
  const [dmSelection, setDmSelection] = useState<string[]>([]);
  const [guildName, setGuildName] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelType, setChannelType] = useState<"guild_text" | "category">("guild_text");
  /** id tin đang sửa + bản nháp (chỉ một tin tại một thời điểm). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** Tin đang chờ xác nhận xoá — tránh xoá nhầm khi hover. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** Menu chuột phải đang mở: tin nào, ở toạ độ nào. */
  const [messageMenu, setMessageMenu] = useState<{
    message: Message;
    x: number;
    y: number;
  } | null>(null);
  /** Thông báo ngắn ("Đã sao chép") — tự tắt, không cần người dùng đóng. */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Đóng menu khi component bị gỡ (đổi kênh, đăng xuất) và dọn timer của toast:
  // timer còn sống sau khi unmount sẽ `setState` trên component đã chết.
  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );
  const now = useNow();
  const bottomRef = useRef<HTMLDivElement>(null);

  const guildId = state.activeGuildId;
  const channelId = state.activeChannelId;
  const home = guildId === null; // view Home: sidebar hiện danh sách DM
  const channels = useMemo(() => state.channels[guildId ?? ""] ?? [], [state.channels, guildId]);
  const members = useMemo(() => state.members[guildId ?? ""] ?? [], [state.members, guildId]);
  const guildRoles = useMemo(() => state.roles[guildId ?? ""] ?? [], [state.roles, guildId]);
  // Trong DM, tên người gửi có thể không thuộc guild nào của tôi → tra cả danh sách DM.
  const memberById = useMemo(() => {
    const map = new Map<string, GuildMemberSummary>();
    for (const member of members) map.set(member.userId as string, member);
    // Group DM cũng là nguồn tên/avatar cho người ngoài guild của mình.
    for (const dm of state.dms) {
      for (const member of dm.recipients) map.set(member.userId as string, member);
    }
    for (const dmMembers of Object.values(state.members)) {
      for (const member of dmMembers) map.set(member.userId as string, member);
    }
    return map;
  }, [members, state.dms, state.members]);
  /** Danh sách có thể nhắn: mọi thành viên trong mọi guild của tôi, loại chính mình. */
  const dmCandidates = useMemo(() => {
    const map = new Map<string, GuildMemberSummary>();
    for (const dmMembers of Object.values(state.members)) {
      for (const member of dmMembers) {
        if (member.userId === state.me?.id) continue;
        map.set(member.userId as string, member);
      }
    }
    for (const dm of state.dms) {
      for (const member of dm.recipients) {
        if (member.userId === state.me?.id) continue;
        map.set(member.userId as string, member);
      }
    }
    return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [state.members, state.dms, state.me]);
  /** DM có tin chưa đọc lên trước, còn lại theo thời gian tạo (id giảm dần). */
  const sortedDms = useMemo(() => {
    return [...state.dms].sort((a, b) => {
      const aUnread = (state.unread[a.channel.id] ?? 0) > 0 ? 1 : 0;
      const bUnread = (state.unread[b.channel.id] ?? 0) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      return BigInt(a.channel.id) < BigInt(b.channel.id) ? 1 : -1;
    });
  }, [state.dms, state.unread]);
  const dmUnreadTotal = useMemo(
    () => state.dms.reduce((total, dm) => total + (state.unread[dm.channel.id] ?? 0), 0),
    [state.dms, state.unread],
  );
  /** Tổng số mention chưa đọc — badge đỏ trên nút Mentions ở rail. */
  const totalMentions = useMemo(
    () => Object.values(state.mentions).reduce((total, count) => total + count, 0),
    [state.mentions],
  );
  /** Tổng tin chưa đọc (mọi kênh + DM) — hiện trên tiêu đề tab. */
  const totalUnread = useMemo(
    () => Object.values(state.unread).reduce((total, count) => total + count, 0),
    [state.unread],
  );
  /**
   * Tiêu đề tab: `(3) Umaru` / `(2@) Umaru`. Không dùng `<title>` trong index.html
   * vì số này đổi liên tục; đặt ở một effect duy nhất để không đua giữa các chỗ.
   */
  useEffect(() => {
    document.title = formatTabTitle(
      t("appName"),
      { unread: totalUnread, mentions: totalMentions },
      state.notificationSettings.tabTitle,
    );
  }, [totalUnread, totalMentions, state.notificationSettings.tabTitle, t]);

  /** guildId → có kênh nào đang có tin chưa đọc (để chấm xanh trên rail). */
  const guildsWithUnread = useMemo(() => {
    const set = new Set<string>();
    for (const [guildId, channels] of Object.entries(state.channels)) {
      if (channels.some((channel) => (state.unread[channel.id] ?? 0) > 0)) set.add(guildId);
    }
    return set;
  }, [state.channels, state.unread]);
  const activeGuild = state.guilds.find((guild) => guild.id === guildId) ?? null;
  /** Owner hoặc có `MANAGE_ROLES` ở bất kỳ kênh nào thì mở được Server Settings. */
  const canManageRoles = useMemo(() => {
    if (guildId === null) return false;
    if (activeGuild !== null && state.me !== null && activeGuild.ownerId === state.me.id) {
      return true;
    }
    return Object.values(state.permissions).some((bits) =>
      hasPermission(bits, Permission.MANAGE_ROLES),
    );
  }, [guildId, activeGuild, state.me, state.permissions]);
  /** Có `MANAGE_CHANNELS`/`MANAGE_ROLES` ở kênh này (hoặc là owner) thì mở Channel Settings. */
  const canManageChannelSettings = useMemo(() => {
    if (guildId === null || channelId === null) return false;
    if (activeGuild !== null && state.me !== null && activeGuild.ownerId === state.me.id) {
      return true;
    }
    const bits = state.permissions[channelId] ?? 0n;
    return (
      hasPermission(bits, Permission.MANAGE_CHANNELS) ||
      hasPermission(bits, Permission.MANAGE_ROLES)
    );
  }, [guildId, channelId, activeGuild, state.me, state.permissions]);
  /** Có `MANAGE_MESSAGES` ở kênh này thì sửa/xoá được tin của người khác. */
  const canManageMessages = useMemo(() => {
    const permissions = state.permissions;
    return (targetChannelId: string | null): boolean =>
      targetChannelId !== null &&
      hasPermission(permissions[targetChannelId] ?? 0n, Permission.MANAGE_MESSAGES);
  }, [state.permissions]);
  /** Kéo-thả sắp xếp kênh/category — cần `MANAGE_CHANNELS` (hoặc là owner). */
  const canReorderChannels = useMemo(() => {
    if (guildId === null) return false;
    if (activeGuild !== null && state.me !== null && activeGuild.ownerId === state.me.id) {
      return true;
    }
    return Object.values(state.permissions).some((bits) =>
      hasPermission(bits, Permission.MANAGE_CHANNELS),
    );
  }, [guildId, activeGuild, state.me, state.permissions]);
  const messages = channelId === null ? [] : (state.messages[channelId] ?? []);
  const activeChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const activeDm = home ? (state.dms.find((dm) => dm.channel.id === channelId) ?? null) : null;
  /** Tên hiển thị của kênh hiện tại: tên kênh guild hoặc người ở đầu DM. */
  const activeTitle =
    activeDm !== null
      ? dmTitle(activeDm)
      : (activeChannel?.name ?? (home ? t("directMessages") : t("servers")));
  const typingNames = (channelId === null ? [] : (state.typing[channelId] ?? []))
    .filter((entry) => entry.expiresAt > now && entry.userId !== state.me?.id)
    .map((entry) => memberById.get(entry.userId)?.displayName ?? entry.userId)
    .slice(0, 3);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, channelId]);

  // Đổi kênh thì bỏ mọi trạng thái sửa/xoá dở dang.
  useEffect(() => {
    setEditingId(null);
    setEditDraft("");
    setConfirmDeleteId(null);
  }, [channelId]);

  const groups = groupChannels(channels);

  /** channelId → người đang trong phòng thoại (đã sắp theo lúc vào). */
  const voiceByChannel = useMemo(() => {
    const map = new Map<string, VoiceState[]>();
    for (const entry of state.voiceStates) {
      if (entry.guildId !== guildId) continue;
      const list = map.get(entry.channelId);
      if (list === undefined) map.set(entry.channelId, [entry]);
      else list.push(entry);
    }
    return map;
  }, [state.voiceStates, guildId]);
  /** Trạng thái thoại của chính mình trong server đang mở (null = không ở phòng nào). */
  const myVoice = useMemo(
    () => state.voiceStates.find((entry) => entry.userId === state.me?.id) ?? null,
    [state.voiceStates, state.me],
  );

  // ---- Kéo-thả sắp xếp sidebar (chỉ khi có MANAGE_CHANNELS) ----
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  function startDrag(event: ReactDragEvent, channel: Channel): void {
    event.dataTransfer.setData("text/plain", channel.id);
    event.dataTransfer.effectAllowed = "move";
    setDragId(channel.id);
    setDropTarget(null);
  }

  function endDrag(): void {
    setDragId(null);
    setDropTarget(null);
  }

  /** Trước/sau hàng dưới con trỏ — dùng cho cả hàng kênh lẫn tiêu đề danh mục. */
  function zoneAt(event: ReactDragEvent): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  /** Hàng kênh: chèn trước/sau hàng đó. Không cho thả lên chính nó. */
  function rowDragOver(event: ReactDragEvent, channel: Channel): void {
    event.stopPropagation();
    if (dragId === null || dragId === channel.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "row", channel, zone: zoneAt(event) });
  }

  function rowDrop(event: ReactDragEvent, channel: Channel): void {
    event.stopPropagation();
    if (dragId === null || dragId === channel.id) return;
    event.preventDefault();
    commitDrop({ kind: "row", channel, zone: zoneAt(event) });
  }

  /** Tiêu đề danh mục: kéo kênh vào = vào cuối danh mục; kéo danh mục = chèn trước/sau. */
  function categoryDragOver(event: ReactDragEvent, categoryId: string): void {
    event.stopPropagation();
    if (dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "category", categoryId, zone: zoneAt(event) });
  }

  function categoryDrop(event: ReactDragEvent, categoryId: string): void {
    event.stopPropagation();
    if (dragId === null) return;
    event.preventDefault();
    commitDrop({ kind: "category", categoryId, zone: zoneAt(event) });
  }

  /** Vùng trống của một nhóm (kèm nhóm gốc): thả vào = đặt cuối nhóm đó. */
  function groupDragOver(event: ReactDragEvent, groupId: string): void {
    if (dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "group", groupId });
  }

  function groupDrop(event: ReactDragEvent, groupId: string): void {
    if (dragId === null) return;
    event.preventDefault();
    commitDrop({ kind: "group", groupId });
  }

  function commitDrop(target: DropTarget): void {
    const dragged = channels.find((channel) => channel.id === dragId);
    setDragId(null);
    setDropTarget(null);
    if (dragged === undefined) return;
    const drop = resolveDrop(channels, dragged, target);
    if (drop === null) return;
    void state.reorderChannel(dragged.id, drop.parentId, drop.position);
  }

  function rowHighlight(channel: Channel): "before" | "after" | null {
    if (dropTarget?.kind !== "row" || dropTarget.channel.id !== channel.id) return null;
    return dropTarget.zone;
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    setPendingFiles((current) => {
      const result = validateFiles(files, current);
      setAttachError(result.error);
      return result.accepted;
    });
  }

  function removePendingFile(file: File): void {
    setPendingFiles((current) => current.filter((item) => item !== file));
  }

  async function submitMessage() {
    const content = draft.trim();
    // Tin chỉ có tệp vẫn gửi được (server cho phép content rỗng khi có file).
    if (content.length === 0 && pendingFiles.length === 0) return;
    const files = pendingFiles;
    const parent = replyTo;
    setDraft("");
    setPendingFiles([]);
    setAttachError(null);
    setReplyTo(null);
    const sent = await state.sendMessage(content, {
      files,
      replyToId: parent?.id,
    });
    if (!sent) {
      // Gửi lỗi thì trả lại cả nội dung, tệp và ngữ cảnh trả lời.
      setDraft(content);
      setPendingFiles(files);
      setReplyTo(parent);
    }
  }

  function startEdit(message: Message): void {
    setConfirmDeleteId(null);
    setEditingId(message.id);
    setEditDraft(message.content);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft("");
  }

  async function saveEdit(message: Message): Promise<void> {
    // Server từ chối nội dung rỗng; giữ nguyên nội dung cũ thì coi như huỷ.
    if (editDraft.trim().length === 0 || editDraft === message.content) {
      cancelEdit();
      return;
    }
    if (await state.editMessage(message.id, editDraft)) cancelEdit();
  }

  async function removeMessage(message: Message): Promise<void> {
    await state.deleteMessage(message.id);
    setConfirmDeleteId(null);
    if (editingId === message.id) cancelEdit();
  }

  function flashToast(text: string): void {
    setToast(text);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  /**
   * Liên kết tới một tin: `?channel=<id>&message=<id>`.
   *
   * Dùng `origin + pathname` chứ không hardcode host: app chạy được ở localhost,
   * preview và tên miền thật. Deep link đọc cả hai tham số nên dán vào đâu cũng
   * mở đúng kênh **và** cuộn tới đúng tin.
   */
  function messageLink(message: Message): string {
    const base =
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}${window.location.pathname}`;
    return `${base}?channel=${message.channelId}&message=${message.id}`;
  }

  async function copyText(text: string): Promise<void> {
    const ok = await copyToClipboard(text);
    flashToast(ok ? t("copied") : t("copyFailed"));
  }

  /**
   * Các mục của menu chuột phải cho một tin.
   *
   * Thứ tự theo Discord (Trả lời → Sửa → Ghim → Sao chép → Báo cáo/Chặn) và
   * hành động phá huỷ xuống cuối, chữ đỏ. Mục nào người dùng không có quyền thì
   * **không hiện**, thay vì hiện rồi báo lỗi 403.
   */
  function messageMenuItems(message: Message): ContextMenuItem[] {
    const mine = message.authorId === state.me?.id;
    const moderate = mine || canManageMessages(channelId as string);
    const items: ContextMenuItem[] = [
      {
        id: "reply",
        label: t("replyMessage"),
        icon: "↩",
        onSelect: () => setReplyTo(message),
      },
    ];
    if (moderate || activeDm !== null) {
      items.push({
        id: "pin",
        label: message.pinned ? t("unpinMessage") : t("pinMessage"),
        icon: message.pinned ? "📌" : "📍",
        onSelect: () => void state.togglePin(message.id as string),
      });
      items.push({
        id: "edit",
        label: t("editMessage"),
        icon: "✎",
        onSelect: () => startEdit(message),
      });
    }
    items.push({
      id: "copy-text",
      label: t("copyText"),
      icon: "📋",
      onSelect: () => void copyText(message.content),
    });
    items.push({
      id: "copy-link",
      label: t("copyLink"),
      icon: "🔗",
      onSelect: () => void copyText(messageLink(message)),
    });
    if (!mine) {
      items.push({
        id: "report",
        label: t("reportMessage"),
        icon: "🚩",
        onSelect: () =>
          state.openReport({ messageId: message.id as string, label: authorName(message) }),
      });
      items.push({
        id: "block",
        label: t("block"),
        icon: "🚫",
        danger: true,
        onSelect: () => {
          if (window.confirm(t("blockConfirm", { name: authorName(message) }))) {
            void state.blockUser(message.authorId as string);
          }
        },
      });
    }
    if (moderate || activeDm !== null) {
      items.push({
        id: "delete",
        label: t("deleteMessage"),
        icon: "🗑",
        danger: true,
        onSelect: () => setConfirmDeleteId(message.id),
      });
    }
    return items;
  }

  function authorName(message: Message): string {
    if (state.me !== null && message.authorId === state.me.id) return state.me.displayName;
    return memberById.get(message.authorId)?.displayName ?? `#${message.authorId.slice(-4)}`;
  }

  const status = gatewayStatusLabel(state.gatewayStatus, t);
  const statusColor =
    state.gatewayStatus === "ready"
      ? "bg-emerald-400"
      : state.gatewayStatus === "connecting" || state.gatewayStatus === "reconnecting"
        ? "bg-amber-400"
        : "bg-rose-400";

  return (
    <div className="flex h-screen overflow-hidden">
      {/*
        Khung xem chia sẻ màn hình — `fixed` nên nằm ngoài luồng layout, không
        làm nhảy khung chat khi có người bật/tắt chia sẻ.
      */}
      <VoiceScreens screens={state.voiceScreens} />
      {/* Server rail */}
      <nav aria-label={t("servers")} className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-white/5 bg-slate-950 py-3">
        <button
          onClick={() => state.selectHome()}
          title={t("directMessages")}
          className={`relative grid size-10 place-items-center rounded-xl text-sm font-semibold transition ${
            home ? "bg-emerald-400 text-emerald-950" : "bg-white/5 text-slate-300 hover:bg-white/10"
          }`}
        >
          @{" "}
          {dmUnreadTotal > 0 && !home && (
            <span
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full border-2 border-slate-950 bg-emerald-400 px-1 text-center text-[9px] font-bold text-emerald-950"
              aria-label={t("unread")}
            >
              {dmUnreadTotal > 99 ? "99+" : dmUnreadTotal}
            </span>
          )}
        </button>
        <button
          onClick={() => void (state.mentionsOpen ? state.closeMentions() : state.openMentions())}
          title={t("mentions")}
          aria-label={t("mentions")}
          aria-pressed={state.mentionsOpen}
          className={`relative grid size-10 place-items-center rounded-xl text-base transition ${
            state.mentionsOpen
              ? "bg-rose-400 text-rose-950"
              : "bg-white/5 text-slate-300 hover:bg-white/10"
          }`}
        >
          🔔
          {totalMentions > 0 && !state.mentionsOpen && (
            <span
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full border-2 border-slate-950 bg-rose-500 px-1 text-center text-[9px] font-bold text-white"
              aria-label={`${totalMentions} ${t("mentionsBadge")}`}
            >
              {totalMentions > 99 ? "99+" : totalMentions}
            </span>
          )}
        </button>
        {state.guilds.map((guild) => {
          const active = guild.id === guildId;
          return (
            <button
              key={guild.id}
              onClick={() => state.selectGuild(guild.id)}
              title={guild.name}
              className={`relative grid size-10 place-items-center rounded-xl text-sm font-semibold transition ${
                active
                  ? "bg-emerald-400 text-emerald-950"
                  : "bg-white/5 text-slate-300 hover:bg-white/10"
              }`}
            >
              {guild.name.slice(0, 1).toUpperCase()}
              {guildsWithUnread.has(guild.id) && !active && (
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-slate-950 bg-emerald-400" />
              )}
            </button>
          );
        })}
        <button
          onClick={() => setShowCreateGuild(true)}
          title={t("addServer")}
          className="grid size-10 place-items-center rounded-xl border border-dashed border-white/15 text-lg text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-400/10"
        >
          +
        </button>
      </nav>

      {/* Channel sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-slate-900/60">
        <header className="flex items-center justify-between border-b border-white/5 px-3 py-3">
          <h2 className="truncate text-sm font-semibold">
            {home ? t("directMessages") : (activeGuild?.name ?? t("servers"))}
          </h2>
          <span className="flex shrink-0 items-center gap-1">
            {!home && canManageRoles && (
              <button
                onClick={() =>
                  void (state.settingsOpen ? state.closeSettings() : state.openSettings())
                }
                title={t("serverSettings")}
                aria-label={t("serverSettings")}
                aria-pressed={state.settingsOpen}
                className={`rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100 ${
                  state.settingsOpen ? "bg-white/10 text-slate-100" : ""
                }`}
              >
                ⚙
              </button>
            )}
            <button
              onClick={() => {
                if (!home) {
                  setShowCreateChannel(true);
                  return;
                }
                setDmSelection([]);
                setShowNewDm(true);
              }}
              disabled={!home && guildId === null}
              title={home ? t("newMessage") : t("addChannel")}
              className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100 disabled:opacity-40"
            >
              +
            </button>
          </span>
        </header>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {home ? (
            <>
              {state.dms.length === 0 && (
                <p className="px-2 py-4 text-xs text-slate-400">{t("noDms")}</p>
              )}
              {sortedDms.map((dm) => {
                const unread = state.unread[dm.channel.id] ?? 0;
                const mentions = state.mentions[dm.channel.id] ?? 0;
                return (
                  <button
                    key={dm.channel.id}
                    onClick={() => void state.selectDm(dm.channel.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                      dm.channel.id === channelId
                        ? "bg-white/10 text-slate-100"
                        : unread > 0 || mentions > 0
                          ? "text-slate-100 hover:bg-white/5"
                          : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    }`}
                  >
                    <span className="relative shrink-0">
                      <Avatar avatarUrl={dmAvatarUrl(dm)} name={dmInitial(dm)} />
                      {/* DM 1-1: chấm của người bên kia. Nhóm thì không có một
                          trạng thái duy nhất nên bỏ trống. */}
                      {dm.recipient !== null && (
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-slate-900 ${PRESENCE_DOT[presenceOf(state.presence, dm.recipient.userId as string)]}`}
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className={`truncate ${unread > 0 || mentions > 0 ? "font-semibold" : ""}`}>
                      {dmTitle(dm)}
                    </span>
                    {/* Mình là người gửi yêu cầu nhắn tin: người kia chưa đồng ý. */}
                    {dm.requestPending && (
                      <span title={t("messageRequestPending")} aria-label={t("messageRequestPending")}>
                        ⏳
                      </span>
                    )}
                    <UnreadBadge
                      unread={unread}
                      mentions={mentions}
                      unreadLabel={t("unread")}
                      mentionLabel={t("mentionsBadge")}
                    />
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {state.guilds.length === 0 && (
                <p className="px-2 py-4 text-xs text-slate-400">{t("noServers")}</p>
              )}
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="mb-2 rounded-lg"
                  onDragOver={(event) => groupDragOver(event, group.id)}
                  onDrop={(event) => groupDrop(event, group.id)}
                >
                  {group.name !== null && (
                    <div
                      className="group/category flex items-center gap-1 rounded-lg px-2 pb-1 pt-2"
                      draggable={canReorderChannels}
                      onDragStart={(event) => {
                        const category = channels.find((entry) => entry.id === group.id);
                        if (category !== undefined) startDrag(event, category);
                      }}
                      onDragOver={(event) => categoryDragOver(event, group.id)}
                      onDrop={(event) => categoryDrop(event, group.id)}
                      onDragEnd={endDrag}
                    >
                      <p className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        {group.name}
                      </p>
                      {canManageChannelSettings && group.id !== "root" && (
                        <button
                          type="button"
                          onClick={() => void state.openChannelSettings(group.id)}
                          title={t("editCategory")}
                          aria-label={`${t("editCategory")}: ${group.name}`}
                          className="rounded px-1 text-[10px] text-slate-500 opacity-0 transition hover:bg-white/5 hover:text-slate-200 group-hover/category:opacity-100 focus-visible:opacity-100"
                        >
                          ⚙
                        </button>
                      )}
                    </div>
                  )}
                  {group.channels.map((channel) => (
                    <div key={channel.id}>
                    <ChannelButton
                      channel={channel}
                      active={channel.id === channelId}
                      onSelect={() => void state.selectChannel(channel.id)}
                      onVoiceToggle={() => void state.toggleVoice(channel.id)}
                      voiceActive={myVoice?.channelId === channel.id}
                      voiceLabel={t("voiceChannel")}
                      voiceJoinLabel={t("voiceJoin")}
                      voiceLeaveLabel={t("voiceLeave")}
                      unread={state.unread[channel.id] ?? 0}
                      mentions={state.mentions[channel.id] ?? 0}
                      unreadLabel={t("unread")}
                      mentionLabel={t("mentionsBadge")}
                      drag={
                        canReorderChannels
                          ? {
                              highlight: rowHighlight(channel),
                              onDragStart: (event) => startDrag(event, channel),
                              onDragOver: (event) => rowDragOver(event, channel),
                              onDrop: (event) => rowDrop(event, channel),
                              onDragEnd: endDrag,
                            }
                          : undefined
                      }
                    />
                    {(voiceByChannel.get(channel.id) ?? []).length > 0 && (
                      <ul className="mb-1 ml-3 space-y-0.5 border-l border-white/10 pl-2">
                        {(voiceByChannel.get(channel.id) ?? []).map((entry) => {
                          // Đèn "đang nói" đến từ SFU (xem `voiceSpeakers`), không
                          // phải từ trạng thái mute của server — người mute vẫn
                          // không bao giờ sáng đèn.
                          const speaking = isSpeaking(state.voiceSpeakers, entry.userId);
                          return (
                          <li
                            key={entry.userId}
                            className="flex items-center gap-1.5 text-[11px] text-slate-400"
                            data-speaking={speaking ? "true" : undefined}
                          >
                            <span
                              className={`rounded-full transition-shadow ${
                                speaking ? "ring-2 ring-emerald-400" : "ring-2 ring-transparent"
                              }`}
                              title={speaking ? t("voiceSpeaking") : undefined}
                            >
                              <Avatar
                                avatarUrl={memberById.get(entry.userId)?.avatarUrl ?? null}
                                name={memberById.get(entry.userId)?.displayName ?? entry.userId}
                                size="size-4"
                                className="bg-slate-700 text-[8px]"
                              />
                            </span>
                            <span className={`truncate ${speaking ? "text-emerald-200" : ""}`}>
                              {memberById.get(entry.userId)?.displayName ?? entry.userId}
                            </span>
                            {entry.selfMute && (
                              <span title={t("voiceMute")} aria-label={t("voiceMute")}>
                                🔇
                              </span>
                            )}
                            {entry.selfDeaf && (
                              <span title={t("voiceDeafen")} aria-label={t("voiceDeafen")}>
                                🎧
                              </span>
                            )}
                          </li>
                          );
                        })}
                      </ul>
                    )}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Thanh thoại: chỉ hiện khi mình đang ở trong một phòng thoại. */}
        {myVoice !== null && (
          <VoiceBar
            channelName={channels.find((c) => c.id === myVoice.channelId)?.name ?? t("voiceInChannel")}
            selfMute={myVoice.selfMute}
            selfDeaf={myVoice.selfDeaf}
            voiceAudio={state.voiceAudio}
            speakers={state.voiceSpeakers}
            meId={state.me?.id ?? null}
            screenSharing={state.screenSharing}
            onLeave={() => void state.toggleVoice(myVoice.channelId)}
            onToggleMute={() => void state.toggleVoiceMute()}
            onToggleDeafen={() => void state.toggleVoiceDeafen()}
            onToggleScreenShare={() => void state.toggleScreenShare()}
            onRetry={() => void state.retryVoiceAudio()}
          />
        )}

        <div className="border-t border-white/5 px-3 py-2">
          <button
            onClick={() => void state.copyInvite()}
            disabled={channelId === null || home}
            className="mb-2 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            {t("invite")}
          </button>
          {/* Link pháp lý: luôn truy cập được, mở tab mới để không mất trạng thái chat. */}
          <p className="mb-2 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
            <a
              href={legalPath("terms", locale)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300"
            >
              {t("termsShort")}
            </a>
            <span aria-hidden>·</span>
            <a
              href={legalPath("privacy", locale)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300"
            >
              {t("privacyShort")}
            </a>
          </p>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  state.clearAvatarError();
                  setShowProfile(true);
                }}
                title={t("avatarChange")}
                aria-label={t("avatarChange")}
                className="shrink-0 rounded-full ring-emerald-400/0 transition hover:ring-2 hover:ring-emerald-400/60"
              >
                <Avatar
                  avatarUrl={state.me?.avatarUrl ?? null}
                  name={state.me?.displayName ?? "?"}
                  size="size-7"
                  className="bg-slate-700"
                />
              </button>
              <span className="truncate text-xs text-slate-200">{state.me?.displayName}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setLocale(locale === "en" ? "vi" : "en")}
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
                aria-label={t("language")}
              >
                {locale === "en" ? "EN" : "VI"}
              </button>
              {state.admin === true && (
                <a
                  href="/admin/reports"
                  title={t("adminReports")}
                  aria-label={t("adminReports")}
                  className="rounded px-1.5 py-0.5 text-[11px] text-amber-300/80 hover:bg-white/5 hover:text-amber-200"
                >
                  ⚑
                </a>
              )}
              <button
                onClick={() =>
                  void (state.friendsOpen ? state.closeFriends() : state.openFriends())
                }
                title={t("friends")}
                aria-label={t("friends")}
                aria-pressed={state.friendsOpen}
                className={`rounded px-1.5 py-0.5 text-[11px] hover:bg-white/5 hover:text-slate-200 ${
                  state.friendsOpen ? "bg-white/10 text-slate-100" : "text-slate-400"
                }`}
              >
                👥
                {state.messageRequests.length > 0 && !state.friendsOpen && (
                  <span className="ml-0.5 rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                    {state.messageRequests.length}
                  </span>
                )}
              </button>
              <button
                onClick={() =>
                  void (state.blocksOpen ? state.closeBlocks() : state.openBlocks())
                }
                title={t("blockedUsers")}
                aria-label={t("blockedUsers")}
                aria-pressed={state.blocksOpen}
                className={`rounded px-1.5 py-0.5 text-[11px] hover:bg-white/5 hover:text-slate-200 ${
                  state.blocksOpen ? "bg-white/10 text-slate-100" : "text-slate-400"
                }`}
              >
                🛡
              </button>
              <button
                onClick={() => void state.logout()}
                title={t("logout")}
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/5 hover:text-rose-300"
              >
                ⎋
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-slate-900/30">
        {/*
          Trước đây khi gateway không kết nối được, giao diện **im lặng**: sidebar
          trống trơn như thể bạn không ở server nào. Đó chính là lý do người dùng
          tưởng "mất server" và tạo server liên tục. Giờ nói thẳng và cho bấm lại.
        */}
        {state.gatewayStatus !== "ready" && (
          <div
            role="status"
            className={`flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs ${
              state.gatewayStatus === "connecting" || state.gatewayStatus === "reconnecting"
                ? "border-amber-400/20 bg-amber-400/10 text-amber-200"
                : "border-rose-400/20 bg-rose-400/10 text-rose-200"
            }`}
          >
            <span aria-hidden>●</span>
            <span className="flex-1">
              {state.gatewayStatus === "connecting" || state.gatewayStatus === "reconnecting"
                ? t("connecting")
                : t("connectionLost")}
            </span>
            <button
              type="button"
              onClick={() => void state.connectGateway()}
              className="rounded border border-current/40 px-2 py-0.5 font-medium hover:bg-white/10"
            >
              {t("retry")}
            </button>
          </div>
        )}
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          {activeDm !== null && isGroupDm(activeDm) && (
            <button
              type="button"
              onClick={() =>
                void (state.groupPanelOpen ? state.closeGroupPanel() : state.openGroupPanel())
              }
              title={t("groupDm")}
              aria-pressed={state.groupPanelOpen}
              className={`mr-2 shrink-0 rounded px-1 text-xs ${
                state.groupPanelOpen
                  ? "bg-white/10 text-slate-100"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
              }`}
            >
              👥
            </button>
          )}
          <h1 className="truncate text-sm font-semibold">
            {state.friendsOpen
              ? `👥 ${t("friends")}`
              : state.blocksOpen
              ? `🛡 ${t("blockedUsers")}`
              : state.pinsOpen
              ? `📌 ${t("pinnedMessages")}`
              : state.searchOpen
              ? `🔍 ${t("search")}`
              : state.channelSettingsChannelId !== null
              ? `⚙ ${t("channelSettings")}`
              : state.settingsOpen
                ? `⚙ ${t("serverSettings")}`
                : state.mentionsOpen
                  ? `@ ${t("mentions")}`
                  : activeDm !== null
                    ? `@ ${activeTitle}`
                    : activeChannel?.name != null
                      ? `# ${activeTitle}`
                      : activeTitle}
          </h1>
          {activeChannel?.topic !== null && activeChannel?.topic !== undefined && activeChannel.topic.length > 0 && (
            <>
              <span aria-hidden className="mx-2 h-5 w-px shrink-0 bg-white/10" />
              <p className="hidden min-w-0 flex-1 truncate text-xs text-slate-400 md:block">
                {activeChannel.topic}
              </p>
            </>
          )}
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {activeChannel?.type === "guild_text" && canManageChannelSettings && (
              <button
                onClick={() =>
                  void (state.channelSettingsChannelId === activeChannel.id
                    ? state.closeChannelSettings()
                    : state.openChannelSettings(activeChannel.id))
                }
                title={t("channelSettings")}
                aria-label={t("channelSettings")}
                aria-pressed={state.channelSettingsChannelId === activeChannel.id}
                className={`rounded px-1 text-slate-400 hover:bg-white/5 hover:text-slate-100 ${
                  state.channelSettingsChannelId === activeChannel.id
                    ? "bg-white/10 text-slate-100"
                    : ""
                }`}
              >
                ⚙
              </button>
            )}
            {channelId !== null && (
              <button
                onClick={() => void (state.pinsOpen ? state.closePins() : state.openPins())}
                title={t("pinnedMessages")}
                aria-label={t("pinnedMessages")}
                aria-pressed={state.pinsOpen}
                className={`rounded px-1 hover:bg-white/5 hover:text-slate-100 ${
                  state.pinsOpen ? "bg-white/10 text-slate-100" : ""
                }`}
              >
                📌
              </button>
            )}
            <button
              onClick={() => void (state.searchOpen ? state.closeSearch() : state.openSearch())}
              title={t("search")}
              aria-label={t("search")}
              aria-pressed={state.searchOpen}
              className={`rounded px-1 hover:bg-white/5 hover:text-slate-100 ${
                state.searchOpen ? "bg-white/10 text-slate-100" : ""
              }`}
            >
              🔍
            </button>
            <span className={`size-2 rounded-full ${statusColor}`} aria-hidden />
            {status}
          </div>
        </header>

        {state.notice !== null && (
          <button
            onClick={() => state.clearNotice()}
            className="border-b border-emerald-400/20 bg-emerald-400/10 px-4 py-1.5 text-left text-xs text-emerald-200"
          >
            {t("inviteCopied", { code: state.notice })}
          </button>
        )}

        {/* Kết quả xác thực email / gửi lại mail — tự đóng được. */}
        {state.banner !== null && (
          <button
            onClick={() => state.clearBanner()}
            role="status"
            className={`border-b px-4 py-1.5 text-left text-xs ${
              state.banner.kind === "success"
                ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
                : "border-rose-400/20 bg-rose-400/10 text-rose-200"
            }`}
          >
            {state.banner.text}
            <span className="ml-2 text-[11px] opacity-70">({t("dismiss")})</span>
          </button>
        )}

        {/* Nhắc xác thực email: chỉ hiện khi đã đăng nhập mà email chưa xác thực. */}
        {state.me !== null && !state.me.emailVerified && (
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-4 py-1.5 text-xs text-amber-200">
            <span aria-hidden>✉</span>
            <span className="flex-1">{t("emailUnverified")}</span>
            <button
              onClick={() => void state.resendVerification()}
              className="rounded border border-amber-300/40 px-2 py-0.5 font-medium hover:bg-amber-300/10"
            >
              {t("resendVerification")}
            </button>
          </div>
        )}

        {state.reportTarget !== null && (
          <ReportDialog
            label={state.reportTarget.label}
            sending={state.reportSending}
            onCancel={() => state.closeReport()}
            onSubmit={(input) => void state.submitReport(input)}
          />
        )}

        {state.friendsOpen ? (
          <FriendsPanel
            friends={state.friends}
            loading={state.friendsLoading}
            requests={state.messageRequests}
            requestsLoading={state.messageRequestsLoading}
            onAcceptRequest={(channelId) => void state.acceptMessageRequest(channelId)}
            onDeclineRequest={(channelId) => void state.declineMessageRequest(channelId)}
            presence={state.presence}
            query={state.friendQuery}
            onQueryChange={(value) => state.setFriendQuery(value)}
            onAdd={(username) => void state.addFriend(username)}
            onAccept={(userId) => void state.acceptFriend(userId)}
            onRemove={(userId) => void state.removeFriend(userId)}
            onDmPrivacy={(privacy) => void state.setDmPrivacy(privacy)}
          />
        ) : state.blocksOpen ? (
          <BlocksPanel
            blocks={state.blocks}
            loading={state.blocksLoading}
            onUnblock={(userId) => void state.unblockUser(userId)}
          />
        ) : state.groupPanelOpen && activeDm !== null && isGroupDm(activeDm) ? (
          <GroupDmPanel dm={activeDm} />
        ) : state.pinsOpen ? (
          <PinsPanel
            pins={state.pins}
            loading={state.pinsLoading}
            locale={locale}
            emptyLabel={t("noPins")}
            loadingLabel={t("loading")}
            hintLabel={t("pinLimitHint")}
            unpinLabel={t("unpinMessage")}
            canUnpin={activeDm !== null || canManageMessages(channelId)}
            onSelect={(message) => void state.jumpToPinnedMessage(message.id as string)}
            onUnpin={(message) => void state.togglePin(message.id as string)}
          />
        ) : state.searchOpen ? (
          <SearchPanel
            query={state.searchQuery}
            scope={state.searchScope}
            canSearchGuild={state.activeGuildId !== null}
            channelLabel={activeTitle}
            hits={state.searchResults}
            submittedFor={state.searchSubmittedFor}
            loading={state.searchLoading}
            hasMore={state.searchHasMore}
            locale={locale}
            onQueryChange={(value) => state.setSearchQuery(value)}
            onScopeChange={(scope: SearchScope) => state.setSearchScope(scope)}
            onSubmit={() => void state.runSearch()}
            onSelect={(hit) => void state.openSearchHit(hit)}
            onLoadMore={() => void state.loadMoreSearch()}
          />
        ) : state.channelSettingsChannelId !== null ? (
          <ChannelSettings />
        ) : state.settingsOpen ? (
          <RoleSettings />
        ) : state.mentionsOpen ? (
          <MentionsPanel
            items={state.mentionItems}
            loading={state.mentionLoading}
            hasMore={state.mentionHasMore}
            emptyLabel={t("noMentions")}
            loadingLabel={t("loading")}
            loadMoreLabel={t("loadMore")}
            locale={locale}
            onSelect={(mention) => void state.jumpToMention(mention)}
            onLoadMore={() => void state.loadMoreMentions()}
          />
        ) : channelId === null ? (
          <div className="grid flex-1 place-items-center px-6 text-sm text-slate-500">
            {t("noChannel")}
          </div>
        ) : (
          <>
            <div
              className="relative flex-1"
              onDragOver={(event) => {
                // Chỉ bắt khi thật sự kéo tệp từ hệ điều hành — kéo-thả
                // sắp xếp kênh ở sidebar dùng dataTransfer khác.
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFiles(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDraggingFiles(false);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFiles(false);
                addFiles([...event.dataTransfer.files]);
              }}
            >
              {draggingFiles && (
                <div className="pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-xl border-2 border-dashed border-emerald-400/60 bg-emerald-400/10 text-sm font-medium text-emerald-200">
                  {t("dropToAttach")}
                </div>
              )}
            <div className="h-full overflow-y-auto py-3">
              {messages.length === 0 ? (
                // Khung chào giống Discord: người vào kênh trống phải biết mình
                // đang ở đâu và làm gì tiếp, thay vì một dòng xám lạc lõng.
                <div className="px-6 py-12 text-center">
                  <p
                    aria-hidden
                    className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-white/5 text-2xl text-slate-400"
                  >
                    {activeDm === null ? "#" : "@"}
                  </p>
                  <h2 className="text-lg font-semibold text-slate-200">
                    {activeTitle.length > 0
                      ? t("channelWelcome", { name: activeTitle })
                      : t("emptyChannel")}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">{t("emptyChannel")}</p>
                </div>
              ) : (
                buildTimeline(messages).map((item) => {
                  if (item.kind === "divider") {
                    return (
                      <div key={item.key} className="flex items-center gap-3 px-4 py-3">
                        <span className="h-px flex-1 bg-white/10" />
                        <span className="text-[11px] font-semibold text-slate-400">
                          {dividerLabel(item.timestamp, Date.now(), locale, {
                            today: t("today"),
                            yesterday: t("yesterday"),
                          })}
                        </span>
                        <span className="h-px flex-1 bg-white/10" />
                      </div>
                    );
                  }
                  // Tin liền trước cùng người trong 5 phút → ẩn avatar/tên, chỉ
                  // hiện nội dung như Discord (xem messageTimeline.ts).
                  const { message, grouped } = item;
                  const mine = message.authorId === state.me?.id;
                  // Tin của mình thì luôn có nút; tin người khác chỉ khi có quyền quản lý tin.
                  const canModerate = mine || canManageMessages(channelId);
                  const editing = editingId === message.id;
                  // Tin được trả lời (có thể không còn trong trang đã tải).
                  const repliedTo =
                    message.replyToId === null
                      ? undefined
                      : messages.find((item) => item.id === message.replyToId);
                  return (
                    <article
                      key={message.id}
                      id={`message-${message.id}`}
                      onContextMenu={(event) => {
                        // `preventDefault` để không hiện menu của trình duyệt.
                        event.preventDefault();
                        setMessageMenu({ message, x: event.clientX, y: event.clientY });
                      }}
                      className={`group flex scroll-mt-4 gap-3 px-4 py-1.5 hover:bg-white/[0.03] ${
                        state.highlightMessageId === message.id
                          ? "rounded-lg bg-amber-400/10 ring-1 ring-amber-300/40"
                          : ""
                      }`}
                    >
                      {grouped ? (
                        <time
                          className="mt-0.5 w-8 shrink-0 text-right text-[10px] text-transparent group-hover:text-slate-500"
                          dateTime={message.createdAt}
                        >
                          {new Date(message.createdAt).toLocaleTimeString(locale, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      ) : (
                        <Avatar
                          avatarUrl={
                            message.authorId === state.me?.id
                              ? (state.me?.avatarUrl ?? null)
                              : (memberById.get(message.authorId)?.avatarUrl ?? null)
                          }
                          name={authorName(message)}
                          size="mt-0.5 size-8"
                          textClass="text-xs"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          {!grouped && (
                            <span className="text-sm font-semibold text-slate-100">
                              {authorName(message)}
                            </span>
                          )}
                          {mine && !grouped && (
                            <span className="rounded bg-emerald-400/10 px-1 text-[10px] text-emerald-300">
                              {t("you")}
                            </span>
                          )}
                          {message.pinned && (
                            <span
                              title={t("pinnedChip")}
                              className="rounded bg-amber-300/10 px-1 text-[10px] text-amber-200"
                            >
                              📌 {t("pinnedChip")}
                            </span>
                          )}
                          {!grouped && (
                            <time className="text-[11px] text-slate-500">
                              {new Date(message.createdAt).toLocaleTimeString(locale, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                          )}
                          {message.editedAt !== null && (
                            <span className="text-[10px] text-slate-600">{t("edited")}</span>
                          )}
                          <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={(event) => {
                                // Mở menu tại nút: đường dùng được bằng bàn phím
                                // và trên màn hình cảm ứng (không có chuột phải).
                                const rect = event.currentTarget.getBoundingClientRect();
                                setMessageMenu({
                                  message,
                                  x: rect.right,
                                  y: rect.bottom + 4,
                                });
                              }}
                              title={t("messageMenu")}
                              aria-label={t("messageMenu")}
                              aria-haspopup="menu"
                              className="rounded px-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
                            >
                              ⋯
                            </button>
                            <button
                              type="button"
                              onClick={() => setReplyTo(message)}
                              title={t("replyToMessage", { name: authorName(message) })}
                              aria-label={t("replyMessage")}
                              className="rounded px-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
                            >
                              ↩
                            </button>
                            {!mine && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    state.openReport({
                                      messageId: message.id as string,
                                      label: authorName(message),
                                    })
                                  }
                                  title={t("reportMessage")}
                                  aria-label={t("reportMessage")}
                                  className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                                >
                                  🚩
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (window.confirm(t("blockConfirm", { name: authorName(message) }))) {
                                      void state.blockUser(message.authorId as string);
                                    }
                                  }}
                                  title={t("block")}
                                  aria-label={t("block")}
                                  className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                                >
                                  🚫
                                </button>
                              </>
                            )}
                          </span>
                          {(canModerate || activeDm !== null) && !editing && (
                            <span className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void state.togglePin(message.id as string)}
                                title={message.pinned ? t("unpinMessage") : t("pinMessage")}
                                aria-label={message.pinned ? t("unpinMessage") : t("pinMessage")}
                                aria-pressed={message.pinned}
                                className={`rounded px-1 text-[11px] hover:bg-white/10 ${
                                  message.pinned
                                    ? "text-amber-300"
                                    : "text-slate-400 hover:text-slate-100"
                                }`}
                              >
                                {message.pinned ? "📌" : "📍"}
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(message)}
                                title={t("editMessage")}
                                aria-label={t("editMessage")}
                                className="rounded px-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(message.id)}
                                title={t("deleteMessage")}
                                aria-label={t("deleteMessage")}
                                className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                              >
                                🗑
                              </button>
                            </span>
                          )}
                        </div>

                        {editing ? (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveEdit(message);
                            }}
                            className="mt-1"
                          >
                            <textarea
                              autoFocus
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelEdit();
                                } else if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  void saveEdit(message);
                                }
                              }}
                              rows={1}
                              maxLength={2000}
                              aria-label={t("editMessage")}
                              className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1 text-sm outline-none focus:border-emerald-400/60"
                            />
                            <div className="mt-1 flex items-center gap-2 text-xs">
                              <button
                                type="submit"
                                disabled={editDraft.trim().length === 0}
                                className="rounded bg-emerald-400 px-2 py-0.5 font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
                              >
                                {t("saveEdit")}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                className="rounded px-2 py-0.5 text-slate-300 hover:bg-white/5"
                              >
                                {t("cancel")}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
                            {message.replyToId !== null && (
                              <ReplyQuote
                                parent={repliedTo ?? null}
                                name={repliedTo === undefined ? null : authorName(repliedTo)}
                              />
                            )}
                            {message.content.length > 0 && (
                              <div className="text-sm text-slate-200">
                                <MessageContent content={message.content} />
                              </div>
                            )}
                            <MessageAttachments attachments={message.attachments} />
                          </>
                        )}

                        {confirmDeleteId === message.id && (
                          <div className="mt-1 flex items-center gap-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px]">
                            <span className="text-rose-200">{t("confirmDelete")}</span>
                            <button
                              type="button"
                              onClick={() => void removeMessage(message)}
                              className="rounded bg-rose-500 px-2 py-0.5 font-semibold text-white hover:bg-rose-400"
                            >
                              {t("deleteMessage")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded px-2 py-0.5 text-slate-300 hover:bg-white/5"
                            >
                              {t("cancel")}
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
            </div>

            <div className="h-5 px-4 text-xs text-slate-400">
              {typingNames.length === 1 && t("typingOne", { name: typingNames[0] ?? "" })}
              {typingNames.length > 1 && t("typingMany", { count: typingNames.length })}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitMessage();
              }}
              className="border-t border-white/5 p-3"
              onKeyDown={(event) => {
                if (event.key === "Escape" && replyTo !== null) {
                  event.preventDefault();
                  setReplyTo(null);
                }
              }}
            >
              {replyTo !== null && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/70 px-2 py-1 text-xs">
                  <span className="shrink-0 text-slate-400">
                    {t("replyingTo", { name: authorName(replyTo) })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-500">
                    {replyTo.content.length > 0 ? replyTo.content : t("attachmentOnly")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyTo(null)}
                    title={t("cancelReply")}
                    aria-label={t("cancelReply")}
                    className="rounded px-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"
                  >
                    ✕
                  </button>
                </div>
              )}
              {pendingFiles.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingFiles.map((file) => (
                    <span
                      key={`${file.name}:${file.size}`}
                      className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/70 px-2 py-1 text-xs text-slate-200"
                    >
                      <span aria-hidden>{file.type.startsWith("image/") ? "🖼" : "📄"}</span>
                      <span className="max-w-[12rem] truncate">{file.name}</span>
                      <span className="text-[11px] text-slate-500">{formatBytes(file.size)}</span>
                      <button
                        type="button"
                        onClick={() => removePendingFile(file)}
                        title={t("removeFile", { name: file.name })}
                        aria-label={t("removeFile", { name: file.name })}
                        className="rounded px-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <span className="self-center text-[11px] text-slate-500">
                    {pendingFiles.length}/{MAX_FILES_PER_MESSAGE}
                  </span>
                </div>
              )}
              {attachError !== null && (
                <p className="mb-2 text-xs text-rose-300">{attachError}</p>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    addFiles([...(event.target.files ?? [])]);
                    // Cho phép chọn lại đúng tệp vừa bỏ.
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title={`${t("attachFile")} · ${t("attachHint")}`}
                  aria-label={t("attachFile")}
                  className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:border-emerald-400/40 hover:text-emerald-200"
                >
                  📎
                </button>
                <textarea
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (event.target.value.length > 0) state.notifyTyping();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submitMessage();
                    }
                  }}
                  onPaste={(event) => {
                    // Dán ảnh từ clipboard (chụp màn hình, copy ảnh) → đính kèm.
                    const files = [...(event.clipboardData?.files ?? [])];
                    if (files.length === 0) return;
                    event.preventDefault();
                    addFiles(files);
                  }}
                  rows={1}
                  maxLength={2000}
                  placeholder={
                    activeDm !== null
                      ? t("dmPlaceholder", { name: activeTitle })
                      : t("messagePlaceholder", { channel: activeTitle })
                  }
                  aria-label={
                    activeDm !== null
                      ? t("dmPlaceholder", { name: activeTitle })
                      : t("messagePlaceholder", { channel: activeTitle })
                  }
                  className="max-h-32 min-h-10 flex-1 resize-y rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
                />
                <button
                  type="submit"
                  disabled={draft.trim().length === 0 && pendingFiles.length === 0}
                  className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
                >
                  {t("send")}
                </button>
              </div>
            </form>
          </>
        )}
      </main>

      {/*
        Danh sách thành viên — chỉ ở server (DM không có khái niệm thành viên)
        và ẩn dưới `lg` để không bóp khung chat trên màn hẹp.
      */}
      {!home && guildId !== null && (
        <MemberList
          members={members}
          roles={guildRoles}
          presence={state.presence}
          ownerId={(activeGuild?.ownerId as string | undefined) ?? null}
          meId={(state.me?.id as string | undefined) ?? null}
          defaultSectionLabel={t("members")}
          countLabel={(count) => `${t("members")} — ${count}`}
          offlineLabel={t("offlineMembers")}
          youLabel={t("you")}
          ownerLabel={t("serverOwner")}
        />
      )}

      {(showCreateGuild || showCreateChannel) && (
        <Modal
          title={
            showCreateGuild
              ? t("addServer")
              : channelType === "category"
                ? t("newCategory")
                : t("addChannel")
          }
          onClose={() => {
            setShowCreateGuild(false);
            setShowCreateChannel(false);
            setChannelType("guild_text");
          }}
          onSubmit={() => {
            if (showCreateGuild) {
              const name = guildName.trim();
              if (name.length === 0) return;
              void state.createGuild(name).then(() => {
                setGuildName("");
                setShowCreateGuild(false);
              });
            } else {
              const name = channelName.trim();
              if (name.length === 0) return;
              void state.createChannel(name, channelType).then(() => {
                setChannelName("");
                setShowCreateChannel(false);
                setChannelType("guild_text");
              });
            }
          }}
          submitLabel={t("create")}
          cancelLabel={t("cancel")}
        >
          <input
            autoFocus
            value={showCreateGuild ? guildName : channelName}
            onChange={(event) =>
              showCreateGuild ? setGuildName(event.target.value) : setChannelName(event.target.value)
            }
            placeholder={showCreateGuild ? t("serverName") : t("channelName")}
            maxLength={100}
            className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
          />
          {showCreateChannel && !showCreateGuild && (
            <>
              <label
                htmlFor="channel-type"
                className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-slate-500"
              >
                {t("channelType")}
              </label>
              <select
                id="channel-type"
                value={channelType}
                onChange={(event) =>
                  setChannelType(event.target.value === "category" ? "category" : "guild_text")
                }
                className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-emerald-400/60"
              >
                <option value="guild_text">{t("textChannel")}</option>
                <option value="category">{t("category")}</option>
              </select>
            </>
          )}
        </Modal>
      )}

      {messageMenu !== null && (
        <ContextMenu
          x={messageMenu.x}
          y={messageMenu.y}
          label={t("messageMenu")}
          items={messageMenuItems(messageMenu.message)}
          onClose={() => setMessageMenu(null)}
        />
      )}

      {toast !== null && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs text-slate-100 shadow-lg ring-1 ring-white/10"
        >
          {toast}
        </div>
      )}

      {showProfile && <ProfileDialog onClose={() => setShowProfile(false)} />}

      {showNewDm && (
        <Modal
          title={t("newMessage")}
          onClose={() => setShowNewDm(false)}
          onSubmit={() => {
            // 1 người → DM 1-1; từ 2 người → group DM (server chặn trần 10).
            if (dmSelection.length === 0) {
              setShowNewDm(false);
              return;
            }
            const [first, ...rest] = dmSelection;
            setShowNewDm(false);
            if (rest.length === 0) void state.openDm(first!);
            else void state.createGroupDm(dmSelection);
          }}
          submitLabel={
            dmSelection.length >= 2
              ? `${t("startGroup")} (${dmSelection.length + 1})`
              : t("startDirectMessage")
          }
          cancelLabel={t("cancel")}
        >
          {dmCandidates.length === 0 ? (
            <p className="py-2 text-xs text-slate-400">{t("noDmCandidates")}</p>
          ) : (
            <>
              <p className="mb-1 text-[11px] text-slate-500">{t("groupPickHint")}</p>
              <ul className="max-h-64 overflow-y-auto">
                {dmCandidates.map((member) => {
                  const id = member.userId as string;
                  const picked = dmSelection.includes(id);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-pressed={picked}
                        onClick={() =>
                          setDmSelection(
                            picked
                              ? dmSelection.filter((entry) => entry !== id)
                              : [...dmSelection, id],
                          )
                        }
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5 ${
                          picked ? "bg-emerald-400/10 text-emerald-100" : "text-slate-200"
                        }`}
                      >
                        <Avatar avatarUrl={member.avatarUrl} name={member.displayName} />
                        <span className="truncate">{member.displayName}</span>
                        <span className="ml-auto text-xs text-slate-500">@{member.username}</span>
                        {picked && <span className="text-xs text-emerald-300">✓</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {dmSelection.length > 0 && (
                <p className="mt-2 text-[11px] text-slate-400">
                  {t("groupSelected", { count: dmSelection.length + 1 })}
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function ChannelButton({
  channel,
  active,
  onSelect,
  onVoiceToggle,
  voiceActive,
  voiceLabel,
  voiceJoinLabel,
  voiceLeaveLabel,
  unread,
  mentions,
  unreadLabel,
  mentionLabel,
  drag,
}: {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
  /** Kênh thoại: vào/ra phòng (một nút cho cả hai chiều). */
  onVoiceToggle?: () => void;
  /** Đang ở trong phòng của kênh này. */
  voiceActive?: boolean;
  voiceLabel: string;
  voiceJoinLabel: string;
  voiceLeaveLabel: string;
  unread: number;
  mentions: number;
  unreadLabel: string;
  mentionLabel: string;
  /** Kéo-thả sắp xếp — thiếu = không có MANAGE_CHANNELS nên không kéo được. */
  drag?: {
    highlight: "before" | "after" | null;
    onDragStart: (event: ReactDragEvent) => void;
    onDragOver: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
    onDragEnd: () => void;
  };
}) {
  const isVoice = channel.type === "guild_voice";
  const highlight = drag?.highlight;
  const canConnect = isVoice && onVoiceToggle !== undefined;
  return (
    <button
      // Kênh thoại: bấm là vào/ra phòng (không mở khung chat). Vẫn kéo-thả được
      // vì drag bắt đầu từ sự kiện riêng, không phải click.
      onClick={canConnect ? onVoiceToggle : isVoice ? undefined : onSelect}
      aria-disabled={isVoice && !canConnect}
      aria-pressed={canConnect ? (voiceActive ?? false) : undefined}
      draggable={drag !== undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      title={
        canConnect
          ? `${voiceActive === true ? voiceLeaveLabel : voiceJoinLabel}: ${channel.name ?? ""}`
          : isVoice
            ? voiceLabel
            : channel.name ?? ""
      }
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
        drag !== undefined ? "cursor-grab active:cursor-grabbing" : ""
      } ${
        highlight === "before"
          ? "shadow-[inset_0_2px_0_0_rgba(52,211,153,0.9)]"
          : highlight === "after"
            ? "shadow-[inset_0_-2px_0_0_rgba(52,211,153,0.9)]"
            : ""
      } ${
        voiceActive === true
          ? "bg-emerald-400/10 text-emerald-200"
          : active
            ? "bg-white/10 text-slate-100"
            : isVoice
              ? "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              : unread > 0 || mentions > 0
              ? "text-slate-100 hover:bg-white/5"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
      }`}
    >
      <span className="text-xs text-slate-500">{isVoice ? "🔊" : "#"}</span>
      <span className={`truncate ${unread > 0 || mentions > 0 ? "font-semibold" : ""}`}>{channel.name}</span>
      <UnreadBadge
        unread={unread}
        mentions={mentions}
        unreadLabel={unreadLabel}
        mentionLabel={mentionLabel}
      />
    </button>
  );
}

function UnreadBadge({
  unread,
  mentions,
  unreadLabel,
  mentionLabel,
}: {
  unread: number;
  mentions: number;
  unreadLabel: string;
  mentionLabel: string;
}) {
  // Mention thắng: badge đỏ hiện số lần bị @, xanh là tin thường.
  if (mentions > 0) {
    return (
      <span
        aria-label={`${mentions} ${mentionLabel}`}
        className="ml-auto min-w-4 shrink-0 rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-4 text-white"
      >
        {mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  if (unread <= 0) return null;
  return (
    <span
      aria-label={`${unread} ${unreadLabel}`}
      className="ml-auto min-w-4 shrink-0 rounded-full bg-emerald-400 px-1 text-center text-[10px] font-bold leading-4 text-emerald-950"
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

/**
 * Panel danh sách tin ghim của kênh đang mở.
 *
 * Tên người gửi/avatar tra từ `useChat` (không truyền xuống như MentionsPanel)
 * vì mỗi dòng chỉ là `Message` — tránh phải nhân bản bảng tra member ở đây.
 */
function PinsPanel({
  pins,
  loading,
  locale,
  emptyLabel,
  loadingLabel,
  hintLabel,
  unpinLabel,
  canUnpin,
  onSelect,
  onUnpin,
}: {
  pins: Message[] | null;
  loading: boolean;
  locale: string;
  emptyLabel: string;
  loadingLabel: string;
  hintLabel: string;
  unpinLabel: string;
  canUnpin: boolean;
  onSelect: (message: Message) => void;
  onUnpin: (message: Message) => void;
}) {
  const state = useChat();
  const me = state.me;
  const byId = useMemo(() => {
    const map = new Map<string, GuildMemberSummary>();
    for (const list of Object.values(state.members)) {
      for (const member of list) map.set(member.userId as string, member);
    }
    for (const dm of state.dms) {
      for (const member of dm.recipients) map.set(member.userId as string, member);
    }
    return map;
  }, [state.members, state.dms]);

  if (pins === null || pins.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500">
        <span>{pins === null && loading ? loadingLabel : emptyLabel}</span>
        <span className="text-[11px] text-slate-600">{hintLabel}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2">
      {pins.map((message) => {
        const mine = message.authorId === me?.id;
        const author = mine
          ? {
              displayName: me?.displayName ?? "",
              avatarUrl: me?.avatarUrl ?? null,
            }
          : {
              displayName:
                byId.get(message.authorId as string)?.displayName ??
                `#${(message.authorId as string).slice(-4)}`,
              avatarUrl: byId.get(message.authorId as string)?.avatarUrl ?? null,
            };
        return (
          <div
            key={message.id}
            className="flex gap-3 px-4 py-2 hover:bg-white/[0.03]"
          >
            <Avatar
              avatarUrl={author.avatarUrl}
              name={author.displayName}
              size="mt-0.5 size-8"
              textClass="text-xs"
            />
            <button
              type="button"
              onClick={() => onSelect(message)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-slate-100">
                  {author.displayName}
                </span>
                <time className="ml-auto shrink-0 text-[11px] text-slate-500">
                  {new Date(message.createdAt).toLocaleString(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-slate-300">
                {message.content.length > 0
                  ? message.content
                  : message.attachments.map((file) => file.filename).join(", ")}
              </p>
            </button>
            {canUnpin && (
              <button
                type="button"
                onClick={() => onUnpin(message)}
                title={unpinLabel}
                aria-label={unpinLabel}
                className="shrink-0 self-start rounded px-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MentionsPanel({
  items,
  loading,
  hasMore,
  emptyLabel,
  loadingLabel,
  loadMoreLabel,
  locale,
  onSelect,
  onLoadMore,
}: {
  items: MessageMention[] | null;
  loading: boolean;
  hasMore: boolean;
  emptyLabel: string;
  loadingLabel: string;
  loadMoreLabel: string;
  locale: string;
  onSelect: (mention: MessageMention) => void;
  onLoadMore: () => void;
}) {
  if (items === null || items.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-sm text-slate-500">
        {items === null && loading ? loadingLabel : emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2">
      {items.map((mention) => {
        // DM không có tên kênh → hiện tên người ở đầu bên kia.
        const where =
          mention.channel.guildId === null
            ? `@ ${mention.recipient?.displayName ?? ""}`
            : `# ${mention.channel.name ?? ""}${
                mention.guildName === null ? "" : ` · ${mention.guildName}`
              }`;
        return (
          <button
            key={mention.message.id}
            onClick={() => onSelect(mention)}
            className="flex w-full gap-3 px-4 py-2 text-left hover:bg-white/[0.03]"
          >
            <Avatar
              avatarUrl={mention.author.avatarUrl}
              name={mention.author.displayName}
              size="mt-0.5 size-8"
              textClass="text-xs"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-slate-100">
                  {mention.author.displayName}
                </span>
                <span className="truncate text-[11px] text-slate-500">{where}</span>
                <time className="ml-auto shrink-0 text-[11px] text-slate-500">
                  {new Date(mention.message.createdAt).toLocaleString(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="truncate text-sm text-slate-200">
                {mention.message.content.length > 0
                  ? mention.message.content
                  : translate("attachmentOnly")}
                {mention.message.attachments.length > 0 && (
                  <span className="ml-1 text-slate-400" title={translate("attachFile")}>
                    📎
                  </span>
                )}
              </p>
            </div>
          </button>
        );
      })}
      {hasMore && (
        <div className="px-4 py-3">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            {loading ? loadingLabel : loadMoreLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Panel tìm kiếm tin nhắn.
 *
 * Không tự tìm khi gõ (tránh bắn request mỗi phím); nhấn Enter hoặc bấm nút mới
 * gọi API. Từ khoá được tô sáng trong phần trích đoạn bằng `splitHighlight`.
 */
function SearchPanel({
  query,
  scope,
  canSearchGuild,
  channelLabel,
  hits,
  submittedFor,
  loading,
  hasMore,
  locale,
  onQueryChange,
  onScopeChange,
  onSubmit,
  onSelect,
  onLoadMore,
}: {
  query: string;
  scope: SearchScope;
  canSearchGuild: boolean;
  channelLabel: string;
  hits: MessageSearchHit[] | null;
  submittedFor: string;
  loading: boolean;
  hasMore: boolean;
  locale: string;
  onQueryChange: (value: string) => void;
  onScopeChange: (scope: SearchScope) => void;
  onSubmit: () => void;
  onSelect: (hit: MessageSearchHit) => void;
  onLoadMore: () => void;
}) {
  const t = useT();
  const trimmed = query.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length >= SEARCH_MIN_LENGTH) onSubmit();
        }}
        className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-2"
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("search")}
          className="min-w-40 flex-1 rounded-lg bg-slate-800/80 px-3 py-1.5 text-sm outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-emerald-400/50"
        />
        <div className="flex overflow-hidden rounded-lg border border-white/10 text-[11px]">
          <button
            type="button"
            onClick={() => onScopeChange("channel")}
            aria-pressed={scope === "channel"}
            className={`px-2 py-1 ${
              scope === "channel" ? "bg-emerald-400/20 text-emerald-200" : "text-slate-400 hover:bg-white/5"
            }`}
          >
            {t("searchInChannel")}
          </button>
          <button
            type="button"
            disabled={!canSearchGuild}
            onClick={() => onScopeChange("guild")}
            aria-pressed={scope === "guild"}
            className={`px-2 py-1 disabled:opacity-40 ${
              scope === "guild" ? "bg-emerald-400/20 text-emerald-200" : "text-slate-400 hover:bg-white/5"
            }`}
          >
            {t("searchInGuild")}
          </button>
        </div>
        <button
          type="submit"
          disabled={loading || trimmed.length < SEARCH_MIN_LENGTH}
          className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
        >
          {loading ? t("loading") : t("search")}
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {hits === null ? (
          <p className="px-4 py-6 text-sm text-slate-500">{t("searchEmpty")}</p>
        ) : hits.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {submittedFor.length < SEARCH_MIN_LENGTH ? t("searchEmpty") : t("searchNoResults")}
          </p>
        ) : (
          <>
            <p className="px-4 pb-1 text-[11px] uppercase tracking-wide text-slate-500">
              {t("searchResultCount", { count: hits.length })}
              {scope === "guild" ? ` · ${t("searchInGuild")}` : ` · ${channelLabel}`}
            </p>
            {hits.map((hit) => {
              const where =
                hit.channel.guildId === null
                  ? `@ ${hit.recipient?.displayName ?? ""}`
                  : `# ${hit.channel.name ?? ""}${
                      hit.guildName === null ? "" : ` · ${hit.guildName}`
                    }`;
              const text = resultText(
                hit.message.content,
                hit.message.attachments.length,
                translate("attachmentOnly"),
              );
              return (
                <button
                  key={hit.message.id}
                  onClick={() => onSelect(hit)}
                  className="flex w-full gap-3 px-4 py-2 text-left hover:bg-white/[0.03]"
                >
                  <Avatar
                    avatarUrl={hit.author.avatarUrl}
                    name={hit.author.displayName}
                    size="mt-0.5 size-8"
                    textClass="text-xs"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-slate-100">
                        {hit.author.displayName}
                      </span>
                      <span className="truncate text-[11px] text-slate-500">{where}</span>
                      <time className="ml-auto shrink-0 text-[11px] text-slate-500">
                        {new Date(hit.message.createdAt).toLocaleString(locale, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p className="truncate text-sm text-slate-300">
                      {splitHighlight(snippetAround(text, submittedFor), submittedFor).map(
                        (segment, index) =>
                          segment.match ? (
                            <mark
                              key={index}
                              className="rounded bg-amber-300/30 px-0.5 text-amber-100"
                            >
                              {segment.text}
                            </mark>
                          ) : (
                            <span key={index}>{segment.text}</span>
                          ),
                      )}
                    </p>
                  </div>
                </button>
              );
            })}
            {hasMore && (
              <div className="px-4 py-3">
                <button
                  onClick={onLoadMore}
                  disabled={loading}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
                >
                  {loading ? t("loading") : t("loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ChannelGroup {
  id: string;
  name: string | null;
  channels: Channel[];
}

function groupChannels(channels: Channel[]): ChannelGroup[] {
  const categories = channels
    .filter((channel) => channel.type === "category")
    .sort((a, b) => a.position - b.position);
  const others = channels
    .filter((channel) => channel.type !== "category")
    .sort((a, b) => a.position - b.position);

  const groups: ChannelGroup[] = [];
  const rootChannels = others.filter((channel) => channel.categoryId === null);
  if (rootChannels.length > 0 || categories.length === 0) {
    groups.push({ id: "root", name: null, channels: rootChannels });
  }
  for (const category of categories) {
    groups.push({
      id: category.id,
      name: category.name,
      channels: others.filter((channel) => channel.categoryId === category.id),
    });
  }
  return groups.filter((group) => group.channels.length > 0 || group.name !== null);
}

function gatewayStatusLabel(
  status: string,
  t: (key: "connected" | "connecting" | "offline") => string,
): string {
  if (status === "ready") return t("connected");
  if (status === "connecting" || status === "reconnecting") return t("connecting");
  return t("offline");
}

function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Modal({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel,
  cancelLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  cancelLabel: string;
}) {
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 className="mb-3 text-sm font-semibold">{title}</h3>
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            {cancelLabel}
          </button>
          {submitLabel.length > 0 && (
            <button
              type="submit"
              className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300"
            >
              {submitLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}


/**
 * Khối trích tin được trả lời.
 * Cha không nằm trong trang đang tải (tin quá cũ, hoặc đã bị xoá) thì hiện
 * nhắc thay vì im lặng — người dùng biết tin này đang trả lời cái gì đó.
 */
function ReplyQuote({ parent, name }: { parent: Message | null; name: string | null }) {
  const t = useT();
  if (parent === null) {
    return (
      <p className="mb-0.5 text-[11px] text-slate-500">↩ {t("originalMessageUnavailable")}</p>
    );
  }
  return (
    <button
      type="button"
      onClick={() =>
        document.getElementById(`message-${parent.id}`)?.scrollIntoView({ block: "center" })
      }
      className="mb-0.5 flex max-w-full items-center gap-1.5 text-left text-[11px] text-slate-500 hover:text-slate-300"
    >
      <span aria-hidden>↩</span>
      <span className="shrink-0 font-medium text-slate-400">{name ?? ""}</span>
      <span className="min-w-0 truncate">
        {parent.content.length > 0 ? parent.content : t("attachmentOnly")}
      </span>
    </button>
  );
}
