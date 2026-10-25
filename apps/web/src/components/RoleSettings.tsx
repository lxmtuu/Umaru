import type { GuildMemberSummary, Role } from "@umaru/protocol";
import { Permission, parsePermissions, serializePermissions } from "@umaru/protocol";
import { useState } from "react";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { PERMISSION_ROWS, colorToHex, hexToColor } from "../lib/roleUi.js";
import { Avatar } from "./Avatar.js";

const DEFAULT_ROLE_PERMISSIONS =
  Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY;

/**
 * Panel Server Settings → Roles: danh sách role (mạnh trước), form sửa/tạo và
 * bảng gán role cho thành viên. Mọi thay đổi đi qua REST của store; server phát
 * `ROLE_*` / `GUILD_MEMBER_UPDATE` nên client khác cập nhật ngay.
 */
export function RoleSettings() {
  const t = useT();
  const state = useChat();
  const guildId = state.activeGuildId;
  const roles = guildId === null ? [] : (state.roles[guildId] ?? []);
  const members = guildId === null ? [] : (state.members[guildId] ?? []);
  const assignable = roles.filter((role) => !role.isEveryone);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#5865f2");
  const [bits, setBits] = useState<bigint>(DEFAULT_ROLE_PERMISSIONS);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const editing = creating || selected !== null;
  const sortedMembers = [...members].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  function pickRole(role: Role): void {
    setCreating(false);
    setSelectedId(role.id);
    setName(role.name);
    setColor(colorToHex(role.color));
    setBits(parsePermissions(role.permissions));
    setConfirmDelete(false);
    state.clearError();
  }

  function startCreate(): void {
    setCreating(true);
    setSelectedId(null);
    setName("");
    setColor("#5865f2");
    setBits(DEFAULT_ROLE_PERMISSIONS);
    setConfirmDelete(false);
    state.clearError();
  }

  function togglePermission(flag: bigint, on: boolean): void {
    setBits((current) => (on ? current | flag : current & ~flag));
  }

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    const payload = {
      name: trimmed,
      color: hexToColor(color),
      permissions: serializePermissions(bits),
    };
    if (creating) {
      const created = await state.createRole(payload);
      setBusy(false);
      if (created !== null) {
        setCreating(false);
        setSelectedId(created.id);
      }
      return;
    }
    if (selected !== null) await state.editRole(selected.id, payload);
    setBusy(false);
  }

  async function remove(): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    const removed = await state.deleteRole(selected.id);
    setBusy(false);
    if (removed) {
      setSelectedId(null);
      setConfirmDelete(false);
    }
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

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("roles")}</h2>
            <button
              type="button"
              onClick={startCreate}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10"
            >
              + {t("newRole")}
            </button>
          </header>

          {roles.length === 0 ? (
            <p className="px-1 py-3 text-xs text-slate-400">{t("noRoles")}</p>
          ) : (
            <ul className="space-y-1">
              {roles.map((role) => (
                <li key={role.id}>
                  <button
                    type="button"
                    onClick={() => pickRole(role)}
                    aria-pressed={!creating && selectedId === role.id}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                      !creating && selectedId === role.id
                        ? "bg-white/10 text-slate-100"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <span
                      className="size-3 shrink-0 rounded-full border border-white/20"
                      style={{ backgroundColor: colorToHex(role.color) }}
                      aria-hidden
                    />
                    <span className="truncate">{role.name}</span>
                    {role.isEveryone && (
                      <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-slate-400">
                        {t("everyoneRoleHint")}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                      {role.position}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          {!editing ? (
            <p className="grid h-full min-h-24 place-items-center text-xs text-slate-500">
              {t("selectRole")}
            </p>
          ) : (
            <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("roleName")}
                  aria-label={t("roleName")}
                  maxLength={100}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1 text-sm outline-none focus:border-emerald-400/60"
                />
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                  aria-label={t("roleColor")}
                  title={t("roleColor")}
                  className="size-8 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
                />
              </div>

              <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {t("rolePermissions")}
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {PERMISSION_ROWS.map((row) => (
                  <label
                    key={row.label}
                    className="flex items-center gap-2 rounded px-1 py-0.5 text-xs text-slate-300 hover:bg-white/5"
                  >
                    <input
                      type="checkbox"
                      checked={(bits & row.flag) === row.flag}
                      onChange={(event) => togglePermission(row.flag, event.target.checked)}
                      className="accent-emerald-400"
                    />
                    {t(row.label)}
                  </label>
                ))}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || name.trim().length === 0}
                  className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
                >
                  {creating ? t("create") : t("save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setSelectedId(null);
                    setConfirmDelete(false);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                >
                  {t("cancel")}
                </button>

                {/* @everyone không xoá được — server cũng trả 400. */}
                {!creating && selected !== null && !selected.isEveryone && (
                  <span className="ml-auto flex items-center gap-2">
                    {confirmDelete ? (
                      <>
                        <span className="text-[11px] text-rose-200">
                          {t("confirmDeleteRole")}
                        </span>
                        <button
                          type="button"
                          onClick={() => void remove()}
                          disabled={busy}
                          className="rounded bg-rose-500 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-400 disabled:opacity-40"
                        >
                          {t("deleteRole")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5"
                        >
                          {t("cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="rounded px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10"
                      >
                        {t("deleteRole")}
                      </button>
                    )}
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {assignable.length > 0 && (
        <section className="mt-6">
          <header className="mb-2">
            <h2 className="text-sm font-semibold">{t("members")}</h2>
            <p className="text-[11px] text-slate-500">{t("assignRolesHint")}</p>
          </header>
          <ul className="space-y-1">
            {sortedMembers.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                roles={assignable}
                busy={busy}
                onToggle={(roleId, assign) =>
                  void state.setMemberRole(member.userId, roleId, assign)
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MemberRow({
  member,
  roles,
  busy,
  onToggle,
}: {
  member: GuildMemberSummary;
  roles: Role[];
  busy: boolean;
  onToggle: (roleId: string, assign: boolean) => void;
}) {
  const held = new Set(member.roleIds);
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
      <Avatar avatarUrl={member.avatarUrl} name={member.displayName} />
      <span className="min-w-0 truncate text-sm text-slate-200">{member.displayName}</span>
      <span className="flex flex-wrap items-center gap-1">
        {roles.map((role) => {
          const on = held.has(role.id);
          const hex = colorToHex(role.color);
          return (
            <button
              key={role.id}
              type="button"
              disabled={busy}
              aria-pressed={on}
              onClick={() => onToggle(role.id, !on)}
              className={`rounded-full border px-1.5 py-0.5 text-[10px] transition disabled:opacity-40 ${
                on ? "font-semibold text-slate-100" : "border-white/10 text-slate-500"
              }`}
              style={on ? { borderColor: hex, backgroundColor: `${hex}33` } : undefined}
            >
              {role.name}
            </button>
          );
        })}
      </span>
    </li>
  );
}

