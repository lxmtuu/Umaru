import type { DmPrivacy, FriendList, FriendRequestSummary, FriendSummary } from "@umaru/protocol";
import { useState } from "react";
import { useT } from "../lib/i18n.js";
import { Avatar } from "./Avatar.js";

/**
 * Panel bạn bè: 3 tab (bạn bè / lời mời đến / đã gửi) + ô thêm bạn + cài đặt
 * ai được nhắn tin cho mình.
 *
 * Panel không tự sửa danh sách sau khi bấm: server phát `FRIEND_ADD` /
 * `FRIEND_REMOVE` cho cả hai phía và store áp vào, nên hai bên luôn khớp nhau.
 */
export function FriendsPanel({
  friends,
  loading,
  query,
  onQueryChange,
  onAdd,
  onAccept,
  onRemove,
  onDmPrivacy,
}: {
  friends: FriendList | null;
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: (username: string) => void;
  onAccept: (userId: string) => void;
  onRemove: (userId: string) => void;
  onDmPrivacy: (privacy: DmPrivacy) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"friends" | "incoming" | "outgoing">("friends");

  const tabs: Array<{ key: typeof tab; label: string; count: number }> = [
    { key: "friends", label: t("friendsTabAll"), count: friends?.friends.length ?? 0 },
    { key: "incoming", label: t("friendsTabIncoming"), count: friends?.incoming.length ?? 0 },
    { key: "outgoing", label: t("friendsTabOutgoing"), count: friends?.outgoing.length ?? 0 },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const username = query.trim();
          if (username.length === 0) return;
          onAdd(username);
        }}
        className="flex gap-2 border-b border-white/5 px-4 py-3"
      >
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("friendAddPlaceholder")}
          aria-label={t("friendAddPlaceholder")}
          className="min-w-0 flex-1 rounded border border-white/10 bg-slate-950/60 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-400/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={query.trim().length === 0}
          className="shrink-0 rounded bg-indigo-500 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          {t("friendAddAction")}
        </button>
      </form>

      <div className="flex items-center gap-1 border-b border-white/5 px-2 py-1.5">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setTab(entry.key)}
            aria-pressed={tab === entry.key}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              tab === entry.key
                ? "bg-white/10 text-slate-100"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {entry.label}
            {entry.count > 0 && <span className="ml-1 opacity-60">({entry.count})</span>}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2 text-[11px] text-slate-400">
        <label htmlFor="dm-privacy" className="flex-1">
          {t("dmPrivacyLabel")}
        </label>
        <select
          id="dm-privacy"
          value={friends?.dmPrivacy ?? "everyone"}
          onChange={(event) => onDmPrivacy(event.target.value as DmPrivacy)}
          disabled={friends === null}
          className="rounded border border-white/10 bg-slate-950/60 px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none disabled:opacity-40"
        >
          <option value="everyone">{t("dmPrivacyEveryone")}</option>
          <option value="friends">{t("dmPrivacyFriends")}</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {friends === null && loading ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">{t("loading")}</p>
        ) : tab === "friends" ? (
          <FriendRows
            entries={friends?.friends ?? []}
            empty={t("friendsEmpty")}
            actionLabel={t("unfriend")}
            onAction={onRemove}
          />
        ) : tab === "incoming" ? (
          <RequestRows
            entries={friends?.incoming ?? []}
            empty={t("friendIncomingEmpty")}
            primaryLabel={t("friendAccept")}
            secondaryLabel={t("friendDecline")}
            onPrimary={onAccept}
            onSecondary={onRemove}
          />
        ) : (
          <RequestRows
            entries={friends?.outgoing ?? []}
            empty={t("friendOutgoingEmpty")}
            secondaryLabel={t("friendCancel")}
            onSecondary={onRemove}
          />
        )}
      </div>
    </div>
  );
}

function FriendRows({
  entries,
  empty,
  actionLabel,
  onAction,
}: {
  entries: FriendSummary[];
  empty: string;
  actionLabel: string;
  onAction: (userId: string) => void;
}) {
  if (entries.length === 0) return <EmptyRow text={empty} />;
  return (
    <>
      {entries.map((entry) => (
        <PersonRow
          key={entry.user.id}
          user={entry.user}
          actions={
            <button
              onClick={() => onAction(entry.user.id)}
              className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-rose-500/20 hover:text-rose-200"
            >
              {actionLabel}
            </button>
          }
        />
      ))}
    </>
  );
}

function RequestRows({
  entries,
  empty,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}: {
  entries: FriendRequestSummary[];
  empty: string;
  primaryLabel?: string;
  secondaryLabel: string;
  onPrimary?: (userId: string) => void;
  onSecondary: (userId: string) => void;
}) {
  if (entries.length === 0) return <EmptyRow text={empty} />;
  return (
    <>
      {entries.map((entry) => (
        <PersonRow
          key={entry.user.id}
          user={entry.user}
          actions={
            <>
              {primaryLabel !== undefined && onPrimary !== undefined && (
                <button
                  onClick={() => onPrimary(entry.user.id)}
                  className="rounded bg-emerald-500/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-400"
                >
                  {primaryLabel}
                </button>
              )}
              <button
                onClick={() => onSecondary(entry.user.id)}
                className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"
              >
                {secondaryLabel}
              </button>
            </>
          }
        />
      ))}
    </>
  );
}

function PersonRow({
  user,
  actions,
}: {
  user: FriendSummary["user"];
  actions: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <Avatar avatarUrl={user.avatarUrl} name={user.displayName} size="size-8" textClass="text-xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-100">{user.displayName}</p>
        <p className="truncate text-[11px] text-slate-500">@{user.username}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-4 py-6 text-center text-sm text-slate-500">{text}</p>;
}
