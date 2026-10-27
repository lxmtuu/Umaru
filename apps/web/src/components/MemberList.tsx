import type { GuildMemberSummary, PresenceStatus, Role } from "@umaru/protocol";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Avatar } from "./Avatar.js";
import { useLocale } from "../lib/i18n.js";
import { groupMembersByRole, type MemberSection } from "../lib/memberList.js";
import { PRESENCE_DOT, partitionByPresence, presenceOf } from "../lib/presence.js";

/**
 * Danh sách thành viên bên phải — thứ Discord luôn có ở mỗi server.
 *
 * Trước đây app chỉ có cột kênh và khung chat: muốn biết server có ai thì phải
 * mở panel Bạn bè, và không thấy được ai giữ role gì. Component này chỉ nhận
 * props (không đọc store) để render được trong test.
 *
 * Bố cục giống Discord: người **đang online** nhóm theo role cao nhất (thứ tự
 * nhóm = thẩm quyền role), người **ngoại tuyến** (kể cả người chọn "Ẩn") gom vào
 * một nhóm cuối, tên mờ đi.
 */

export interface MemberListProps {
  members: GuildMemberSummary[];
  roles: Role[];
  /** userId → trạng thái; thiếu = offline. */
  presence?: Record<string, PresenceStatus>;
  /** Chủ server — có vương miện, không phụ thuộc role. */
  ownerId: string | null;
  meId: string | null;
  /** Nhãn cho nhóm người không có role riêng (thường là "Thành viên"). */
  defaultSectionLabel: string;
  /** Nhãn đếm, ví dụ "Thành viên — 12". */
  countLabel: (count: number) => string;
  /** Nhãn nhóm ngoại tuyến, thường là "Ngoại tuyến". */
  offlineLabel: string;
  youLabel: string;
  ownerLabel: string;
  /**
   * Menu chuột phải trên một thành viên (Nhắn tin / Sao chép tên / Chặn).
   * Tuỳ chọn để `MemberList` vẫn dùng được ở nơi không cần menu.
   */
  onMemberContextMenu?: (member: GuildMemberSummary, event: ReactMouseEvent) => void;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function dotClass(status: PresenceStatus): string {
  return PRESENCE_DOT[status];
}

export function MemberList({
  members,
  roles,
  presence,
  ownerId,
  meId,
  defaultSectionLabel,
  countLabel,
  offlineLabel,
  youLabel,
  ownerLabel,
  onMemberContextMenu,
}: MemberListProps) {
  // `locale` để component render lại khi đổi ngôn ngữ, kể cả khi props không đổi.
  useLocale((state) => state.locale);
  const { online, offline } = partitionByPresence(members, presence);
  const sections: MemberSection[] = groupMembersByRole({
    members: online,
    roles,
    defaultSectionLabel,
  });

  const row = (member: GuildMemberSummary, sectionColor: number | null, muted: boolean) => {
    const isOwner = ownerId !== null && member.userId === ownerId;
    const isMe = meId !== null && member.userId === meId;
    const status = presenceOf(presence, member.userId as string);
    return (
      <li key={member.userId}>
        <div
          className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-white/5"
          title={isOwner ? ownerLabel : undefined}
          onContextMenu={
            onMemberContextMenu === undefined
              ? undefined
              : (event) => onMemberContextMenu(member, event)
          }
        >
          <span className="relative shrink-0">
            <Avatar
              avatarUrl={member.avatarUrl}
              name={member.displayName}
              size="size-7"
              textClass="text-[10px]"
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-slate-900 ${dotClass(status)}`}
              aria-hidden
            />
          </span>
          <span
            className={`truncate text-sm ${muted ? "text-slate-500" : "text-slate-300"}`}
            style={sectionColor === null || muted ? undefined : { color: hex(sectionColor) }}
          >
            {member.displayName}
          </span>
          {isOwner && (
            <span className="shrink-0 text-[10px] text-amber-300" aria-label={ownerLabel}>
              ♛
            </span>
          )}
          {isMe && (
            <span className="ml-auto shrink-0 rounded bg-emerald-400/10 px-1 text-[10px] text-emerald-300">
              {youLabel}
            </span>
          )}
        </div>
      </li>
    );
  };

  return (
    <aside
      aria-label={countLabel(members.length)}
      className="hidden w-56 shrink-0 flex-col overflow-y-auto border-l border-white/5 bg-slate-900/40 px-2 py-3 lg:flex"
    >
      <h2 className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {countLabel(members.length)}
      </h2>
      {sections.map((section) => (
        <section key={section.id} className="mb-2">
          <h3
            className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            style={section.color === null ? undefined : { color: hex(section.color) }}
          >
            {section.name} — {section.members.length}
          </h3>
          <ul>{section.members.map((member) => row(member, section.color, false))}</ul>
        </section>
      ))}
      {offline.length > 0 && (
        <section className="mb-2">
          <h3 className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            {offlineLabel} — {offline.length}
          </h3>
          <ul>{offline.map((member) => row(member, null, true))}</ul>
        </section>
      )}
    </aside>
  );
}
