import type { GuildMemberSummary, Role } from "@umaru/protocol";
import { Avatar } from "./Avatar.js";
import { useLocale } from "../lib/i18n.js";
import { groupMembersByRole, type MemberSection } from "../lib/memberList.js";

/**
 * Danh sách thành viên bên phải — thứ mà Discord luôn có ở mỗi server.
 *
 * Trước đây app chỉ có cột kênh và khung chat: muốn biết server có ai thì phải
 * mở panel Bạn bè, và không thấy được ai giữ role gì. Component này chỉ nhận
 * props (không đọc store) để render được trong test.
 *
 * Nhóm theo **role cao nhất** của từng người, giống Discord: thứ tự nhóm = thứ
 * tự thẩm quyền role, trong nhóm sắp theo tên. Người chưa có role riêng nằm ở
 * nhóm đầu tiên (nhãn "Thành viên").
 */

export interface MemberListProps {
  members: GuildMemberSummary[];
  roles: Role[];
  /** Chủ server — có vương miện, không phụ thuộc role. */
  ownerId: string | null;
  meId: string | null;
  /** Nhãn cho nhóm người không có role riêng (thường là "Thành viên"). */
  defaultSectionLabel: string;
  /** Nhãn đếm, ví dụ "Thành viên — 12". */
  countLabel: (count: number) => string;
  youLabel: string;
  ownerLabel: string;
  /** Tên role hiển thị dạng tooltip khi rê chuột. */
  roleHoverLabel?: (roleName: string) => string;
}

function colorOf(section: MemberSection): string {
  if (section.color === null) return "text-slate-300";
  return "";
}

export function MemberList({
  members,
  roles,
  ownerId,
  meId,
  defaultSectionLabel,
  countLabel,
  youLabel,
  ownerLabel,
  roleHoverLabel,
}: MemberListProps) {
  // `locale` để component render lại khi đổi ngôn ngữ, kể cả khi props không đổi.
  useLocale((state) => state.locale);
  const sections = groupMembersByRole({ members, roles, defaultSectionLabel });

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
            style={section.color === null ? undefined : { color: `#${section.color.toString(16).padStart(6, "0")}` }}
          >
            {section.name} — {section.members.length}
          </h3>
          <ul>
            {section.members.map((member) => {
              const isOwner = ownerId !== null && member.userId === ownerId;
              const isMe = meId !== null && member.userId === meId;
              return (
                <li key={member.userId}>
                  <div
                    className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-white/5"
                    title={
                      isOwner
                        ? ownerLabel
                        : roleHoverLabel === undefined
                          ? undefined
                          : roleHoverLabel(section.name)
                    }
                  >
                    {/* Chấm trạng thái: chưa có presence thật nên chỉ hiện khi
                        chính mình — hiện "trực tuyến" cho mọi người là nói dối. */}
                    <span className="relative shrink-0">
                      <Avatar avatarUrl={member.avatarUrl} name={member.displayName} size="size-7" textClass="text-[10px]" />
                      {isMe && (
                        <span
                          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-slate-900 bg-emerald-400"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span
                      className={`truncate text-sm ${colorOf(section) || "text-slate-300"}`}
                      style={
                        section.color === null
                          ? undefined
                          : { color: `#${section.color.toString(16).padStart(6, "0")}` }
                      }
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
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
