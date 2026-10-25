import {
  MAX_GROUP_DM_MEMBERS,
  type DmChannelSummary,
  type GuildMemberSummary,
} from "@umaru/protocol";
import { useMemo, useState } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { Avatar } from "./Avatar.js";

/**
 * Panel thành viên của group DM: đổi tên nhóm, mời thêm, mời ra (chủ nhóm), rời nhóm.
 *
 * Quyền đã được server kiểm; UI chỉ ẩn nút cho gọn mắt (server vẫn là nơi
 * quyết định — không tin client).
 */
export function GroupDmPanel({ dm }: { dm: DmChannelSummary }) {
  const t = useT();
  const state = useChat();
  const me = state.me;
  const busy = state.groupBusy;
  const [nameDraft, setNameDraft] = useState(dm.name ?? "");
  const [addOpen, setAddOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const memberIds = useMemo(
    () => new Set(dm.recipients.map((member) => member.userId as string)),
    [dm.recipients],
  );
  /** Người có thể mời: thành viên các server của mình (và người trong DM khác). */
  const candidates = useMemo(() => {
    const map = new Map<string, GuildMemberSummary>();
    for (const list of Object.values(state.members)) {
      for (const member of list) {
        if (member.userId === me?.id) continue;
        if (memberIds.has(member.userId as string)) continue;
        map.set(member.userId as string, member);
      }
    }
    for (const other of state.dms) {
      for (const member of other.recipients) {
        if (member.userId === me?.id) continue;
        if (memberIds.has(member.userId as string)) continue;
        map.set(member.userId as string, member);
      }
    }
    return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [state.members, state.dms, me, memberIds]);

  const isOwner = dm.ownerId !== null && dm.ownerId === me?.id;
  const count = dm.recipients.length + 1;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-white/5 px-4 py-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void state.renameGroupDm(nameDraft.trim().length === 0 ? null : nameDraft.trim());
          }}
          className="flex items-center gap-2"
        >
          <input
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder={t("groupNamePlaceholder")}
            maxLength={100}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-emerald-400/50"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-emerald-400 px-2 py-1 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50"
          >
            {t("save")}
          </button>
        </form>
        <p className="mt-1 text-[11px] text-slate-500">
          {t("groupMemberCount", { count, max: MAX_GROUP_DM_MEMBERS })}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {dm.recipients.map((member) => (
          <div key={member.userId} className="flex items-center gap-3 px-4 py-1.5">
            <Avatar
              avatarUrl={member.avatarUrl}
              name={member.displayName}
              size="size-8"
              textClass="text-xs"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-100">{member.displayName}</p>
              <p className="truncate text-[11px] text-slate-500">@{member.username}</p>
            </div>
            {member.userId === dm.ownerId && (
              <span className="rounded bg-amber-300/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                {t("groupOwner")}
              </span>
            )}
            {isOwner && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void state.removeGroupMember(member.userId as string)}
                title={t("groupRemoveMember")}
                aria-label={t("groupRemoveMember")}
                className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-white/5 px-4 py-3">
        {addOpen ? (
          <div>
            <p className="mb-1 text-[11px] text-slate-500">{t("groupAddHint")}</p>
            <ul className="max-h-48 overflow-y-auto">
              {candidates.length === 0 && (
                <li className="py-1 text-xs text-slate-500">{t("groupNoCandidates")}</li>
              )}
              {candidates.map((candidate) => (
                <li key={candidate.userId}>
                  <button
                    type="button"
                    disabled={busy || count >= MAX_GROUP_DM_MEMBERS}
                    onClick={() => void state.addGroupMember(candidate.userId as string)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-slate-200 hover:bg-white/5 disabled:opacity-40"
                  >
                    <Avatar avatarUrl={candidate.avatarUrl} name={candidate.displayName} />
                    <span className="truncate">{candidate.displayName}</span>
                    <span className="ml-auto text-xs text-slate-500">@{candidate.username}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="mt-1 text-[11px] text-slate-400 hover:text-slate-200"
            >
              {t("close")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy || count >= MAX_GROUP_DM_MEMBERS}
            onClick={() => setAddOpen(true)}
            className="w-full rounded-lg border border-white/10 px-2 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40"
          >
            {count >= MAX_GROUP_DM_MEMBERS ? t("groupFull") : `＋ ${t("groupAddMember")}`}
          </button>
        )}

        {confirmLeave ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void state.leaveGroupDm()}
              className="flex-1 rounded-lg bg-rose-500/90 px-2 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {t("groupLeaveConfirm")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmLeave(false)}
              className="rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-white/5"
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            className="w-full rounded-lg px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
          >
            {t("groupLeave")}
          </button>
        )}
      </div>
    </div>
  );
}
