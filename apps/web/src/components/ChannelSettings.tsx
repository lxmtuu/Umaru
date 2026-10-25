import type { ChannelOverwrite } from "@umaru/protocol";
import { parsePermissions } from "@umaru/protocol";
import { useMemo, useState } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { PERMISSION_ROWS, colorToHex } from "../lib/roleUi.js";

interface Target {
  type: "role" | "member";
  id: string;
}

/**
 * Channel Settings → ghi đè quyền: chọn một role hoặc thành viên rồi bấm từng
 * quyền để xoay vòng **theo role → cho phép → từ chối**. Mở được cho cả category
 * và kênh text; kênh nằm trong category hiện thêm phần **kế thừa** (chỉ đọc) và
 * đổi được category chứa nó.
 */
export function ChannelSettings() {
  const t = useT();
  const state = useChat();
  const channelId = state.channelSettingsChannelId;
  const guildId = state.activeGuildId;
  const guildChannels = useMemo(
    () => (guildId === null ? [] : (state.channels[guildId] ?? [])),
    [state.channels, guildId],
  );
  const channel = guildChannels.find((entry) => entry.id === channelId) ?? null;
  const categories = guildChannels.filter((entry) => entry.type === "category");
  const parentId = channel?.categoryId ?? null;
  const inherited = parentId === null ? [] : (state.overwrites[parentId] ?? []);
  const overwrites = channelId === null ? [] : (state.overwrites[channelId] ?? []);
  const roles = guildId === null ? [] : (state.roles[guildId] ?? []);
  const members = guildId === null ? [] : (state.members[guildId] ?? []);

  const [targetKey, setTargetKey] = useState("");
  const [busy, setBusy] = useState(false);

  const target = parseTargetKey(targetKey);
  const current =
    target === null
      ? null
      : (overwrites.find(
          (entry) => entry.targetType === target.type && entry.targetId === target.id,
        ) ?? null);
  const allow = current === null ? 0n : parsePermissions(current.allow);
  const deny = current === null ? 0n : parsePermissions(current.deny);

  const sorted = useMemo(() => sortOverwrites(overwrites), [overwrites]);
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [members],
  );

  if (channelId === null || channel === null) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-sm text-slate-500">
        {t("loading")}
      </div>
    );
  }

  const isCategory = channel.type === "category";
  // Đã qua guard null ở trên — giữ một biến string để dùng trong closure.
  const settingsChannelId: string = channelId;

  async function cycle(flag: bigint): Promise<void> {
    if (target === null) return;
    const isAllow = (allow & flag) === flag;
    const isDeny = (deny & flag) === flag;
    let nextAllow = allow;
    let nextDeny = deny;
    if (!isAllow && !isDeny) {
      nextAllow = allow | flag;
    } else if (isAllow) {
      nextAllow = allow & ~flag;
      nextDeny = deny | flag;
    } else {
      nextDeny = deny & ~flag;
    }
    setBusy(true);
    await state.setOverwrite(settingsChannelId, target.type, target.id, nextAllow, nextDeny);
    setBusy(false);
  }

  async function reset(): Promise<void> {
    if (target === null) return;
    setBusy(true);
    await state.resetOverwrite(settingsChannelId, target.type, target.id);
    setBusy(false);
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {state.error !== null && (
        <button
          onClick={() => state.clearError()}
          className="mb-3 w-full rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-left text-xs text-rose-200"
        >
          {state.error}
        </button>
      )}

      <header className="mb-3">
        <h2 className="text-sm font-semibold">
          {t("overwrites")}
          <span className="text-slate-400">
            {" · "}
            {isCategory ? `${channel.name}` : `#${channel.name}`}
          </span>
        </h2>
        <p className="text-[11px] text-slate-500">
          {isCategory ? t("categoryOverwritesHint") : t("overwriteHint")}
        </p>
      </header>

      {!isCategory && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <label htmlFor="channel-category" className="text-slate-400">
            {t("category")}
          </label>
          <select
            id="channel-category"
            value={channel.categoryId ?? ""}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setBusy(true);
              void state.moveChannel(settingsChannelId, value === "" ? null : value).then(() => {
                setBusy(false);
                setTargetKey("");
              });
            }}
            className="rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1 outline-none focus:border-emerald-400/60 disabled:opacity-40"
          >
            <option value="">{t("noCategory")}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {!isCategory && inherited.length > 0 && (
        <section className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-300">{t("inheritedOverwrites")}</h3>
            <button
              type="button"
              onClick={() => void state.openChannelSettings(parentId!)}
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              {t("editCategory")}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-slate-500">{t("inheritedHint")}</p>
          <ul className="space-y-1">
            {sortOverwrites(inherited).map((entry) => (
              <li
                key={`${entry.targetType}:${entry.targetId}`}
                className="flex items-center gap-2 text-xs text-slate-400"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full border border-white/20"
                  style={{ backgroundColor: colorToHex(entry.color) }}
                  aria-hidden
                />
                <span className="truncate">{entry.targetName}</span>
                <span className="ml-auto shrink-0 text-[10px]">{bitSummary(entry)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sorted.length === 0 ? (
        <p className="mb-3 px-1 text-xs text-slate-400">{t("noOverwrites")}</p>
      ) : (
        <ul className="mb-4 space-y-1">
          {sorted.map((entry) => {
            const key = `${entry.targetType}:${entry.targetId}`;
            const selected = targetKey === key;
            return (
              <li
                key={key}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                  selected ? "bg-white/10 text-slate-100" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setTargetKey(key)}
                  aria-pressed={selected}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span
                    className="size-3 shrink-0 rounded-full border border-white/20"
                    style={{ backgroundColor: colorToHex(entry.color) }}
                    aria-hidden
                  />
                  <span className="truncate">{entry.targetName}</span>
                  <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-slate-400">
                    {entry.targetType === "role" ? t("roles") : t("members")}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                    {bitSummary(entry)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    void state
                      .resetOverwrite(settingsChannelId, entry.targetType, entry.targetId)
                      .then(() => setBusy(false));
                  }}
                  disabled={busy}
                  title={t("resetOverwrite")}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {t("selectTarget")}
      </label>
      <select
        value={targetKey}
        onChange={(event) => {
          setTargetKey(event.target.value);
          state.clearError();
        }}
        className="mb-3 w-full rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-sm outline-none focus:border-emerald-400/60"
      >
        <option value="">{t("selectTarget")}</option>
        <optgroup label={t("roles")}>
          {roles.map((role) => (
            <option key={role.id} value={`role:${role.id}`}>
              {role.isEveryone ? "@everyone" : role.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("members")}>
          {sortedMembers.map((member) => (
            <option key={member.userId} value={`member:${member.userId}`}>
              {member.displayName}
            </option>
          ))}
        </optgroup>
      </select>

      {target === null ? null : (
        <section className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
          <p className="mb-2 text-[11px] text-slate-500">{t("cycleHint")}</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {PERMISSION_ROWS.map((row) => {
              const isAllow = (allow & row.flag) === row.flag;
              const isDeny = (deny & row.flag) === row.flag;
              const label = isAllow ? t("allowPerm") : isDeny ? t("denyPerm") : t("inheritPerm");
              return (
                <button
                  key={row.label}
                  type="button"
                  disabled={busy}
                  aria-label={`${t(row.label)}: ${label}`}
                  onClick={() => void cycle(row.flag)}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-xs transition disabled:opacity-40 ${
                    isAllow
                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                      : isDeny
                        ? "border-rose-400/40 bg-rose-500/10 text-rose-200"
                        : "border-white/10 text-slate-400 hover:bg-white/5"
                  }`}
                >
                  <span className="truncate">{t(row.label)}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide">{label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy || current === null}
              className="rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >
              {t("resetOverwrite")}
            </button>
            <button
              type="button"
              onClick={() => setTargetKey("")}
              className="rounded-lg px-3 py-1 text-xs text-slate-300 hover:bg-white/5"
            >
              {t("cancel")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function bitSummary(entry: ChannelOverwrite): string {
  const allowed = parsePermissions(entry.allow);
  const denied = parsePermissions(entry.deny);
  const allowCount = countBits(allowed);
  const denyCount = countBits(denied);
  return `${allowCount > 0 ? `+${allowCount}` : ""}${denyCount > 0 ? ` −${denyCount}` : ""}`.trim();
}

function parseTargetKey(value: string): Target | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (id.length === 0 || (type !== "role" && type !== "member")) return null;
  return { type, id };
}

function sortOverwrites(overwrites: ChannelOverwrite[]): ChannelOverwrite[] {
  return [...overwrites].sort((a, b) => {
    if (a.isEveryone !== b.isEveryone) return a.isEveryone ? -1 : 1;
    if (a.targetType !== b.targetType) return a.targetType === "role" ? -1 : 1;
    return a.targetName.localeCompare(b.targetName);
  });
}

function countBits(bits: bigint): number {
  let count = 0;
  for (let value = bits; value !== 0n; value &= value - 1n) count += 1;
  return count;
}
