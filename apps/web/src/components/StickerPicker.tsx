import { useEffect, useRef, useState } from "react";
import type { Sticker } from "@umaru/protocol";
import { useChat } from "../lib/chatStore.js";
import { useT } from "../lib/i18n.js";
import { defaultStickerName, useStickerUrl } from "../lib/stickers.js";

/**
 * Bảng chọn sticker của server đang mở.
 *
 * Chỉ chứa sticker của **server hiện tại** (sticker là biểu cảm của cộng đồng
 * đó, xem migration 0023) — DM không có bảng chọn này.
 *
 * Người có `MANAGE_EXPRESSIONS` thấy thêm phần quản lý ngay trong bảng chọn:
 * tạo gói, tải sticker lên, xoá. Tách thành màn hình riêng thì phải bấm ba lần
 * mới tới được việc hay làm nhất là "thêm sticker vào gói đang dùng".
 */
export function StickerPicker({
  guildId,
  canManage,
  onPick,
  onClose,
}: {
  guildId: string;
  canManage: boolean;
  onPick: (sticker: Sticker) => void;
  onClose: () => void;
}) {
  const t = useT();
  const packs = useChat((state) => state.stickerPacks[guildId] ?? null);
  const busy = useChat((state) => state.stickerBusy);
  const error = useChat((state) => state.stickerError);
  const loadPacks = useChat((state) => state.loadStickerPacks);
  const createPack = useChat((state) => state.createStickerPack);
  const deletePack = useChat((state) => state.deleteStickerPack);
  const uploadSticker = useChat((state) => state.uploadSticker);
  const deleteSticker = useChat((state) => state.deleteSticker);
  const clearError = useChat((state) => state.clearStickerError);

  const [activePackId, setActivePackId] = useState<string | null>(null);
  const [newPackName, setNewPackName] = useState("");
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Tải lại mỗi lần mở: người khác có thể vừa thêm sticker.
  useEffect(() => {
    void loadPacks(guildId);
  }, [guildId, loadPacks]);

  const activePack =
    packs?.find((pack) => pack.id === activePackId) ?? packs?.[0] ?? null;

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || activePack === null) return;
    const ok = await uploadSticker(guildId, activePack.id, defaultStickerName(file.name), file);
    if (!ok) return;
    if (fileRef.current !== null) fileRef.current.value = "";
  };

  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-label={t("stickerPickerTitle")}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <h3 className="text-sm font-semibold">{t("stickerPickerTitle")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {error !== null && (
            <p className="mb-3 flex items-start justify-between gap-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
              <span>{error}</span>
              <button type="button" onClick={clearError} className="shrink-0">
                ✕
              </button>
            </p>
          )}

          {packs === null && <p className="text-xs text-slate-400">{t("loading")}</p>}

          {packs !== null && packs.length === 0 && (
            <p className="text-xs text-slate-400">
              {canManage ? t("stickerEmptyManager") : t("stickerEmpty")}
            </p>
          )}

          {packs !== null && packs.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {packs.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => setActivePackId(pack.id)}
                    aria-pressed={activePack?.id === pack.id}
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      activePack?.id === pack.id
                        ? "bg-white/15 text-slate-100"
                        : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    }`}
                  >
                    {pack.name} · {pack.stickers.length}
                  </button>
                ))}
              </div>

              {activePack !== null && (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    {activePack.stickers.map((sticker) => (
                      <div key={sticker.id} className="relative">
                        <StickerButton sticker={sticker} onPick={() => onPick(sticker)} />
                        {canManage && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`${t("stickerDelete")} ${sticker.name}`}
                            onClick={() => void deleteSticker(guildId, sticker.id)}
                            className="absolute -right-1 -top-1 hidden size-4 place-items-center rounded-full bg-rose-500 text-[10px] text-white group-hover:grid hover:grid"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    {activePack.stickers.length === 0 && (
                      <p className="col-span-4 text-xs text-slate-500">{t("stickerPackEmpty")}</p>
                    )}
                  </div>

                  {canManage && (
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/apng,image/gif,image/webp,image/avif"
                        className="hidden"
                        onChange={(event) => void handleFile(event.target.files?.[0])}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => fileRef.current?.click()}
                        className="rounded-lg bg-emerald-400 px-2 py-1 text-[11px] font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50"
                      >
                        {t("stickerUpload")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void deletePack(guildId, activePack.id)}
                        className="rounded-lg border border-rose-400/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                      >
                        {t("stickerDeletePack")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {canManage && (
            <div className="mt-3 border-t border-white/10 pt-3">
              {creating ? (
                <form
                  className="flex gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = newPackName.trim();
                    if (name.length === 0) return;
                    void createPack(guildId, name).then((ok) => {
                      if (!ok) return;
                      setNewPackName("");
                      setCreating(false);
                    });
                  }}
                >
                  <input
                    autoFocus
                    value={newPackName}
                    maxLength={40}
                    onChange={(event) => setNewPackName(event.target.value)}
                    placeholder={t("stickerPackName")}
                    className="flex-1 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-100 outline-none focus:border-emerald-400/60"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-emerald-400 px-2 py-1 text-[11px] font-semibold text-emerald-950 disabled:opacity-50"
                  >
                    {t("save")}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="text-[11px] text-slate-400 hover:text-slate-200"
                >
                  {t("stickerNewPack")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Một ô sticker: tải ảnh riêng, hiện ô xám khi đang tải/lỗi. */
function StickerButton({ sticker, onPick }: { sticker: Sticker; onPick: () => void }) {
  const state = useStickerUrl(sticker.imageUrl);
  return (
    <button
      type="button"
      onClick={onPick}
      title={sticker.name}
      aria-label={sticker.name}
      className="group grid size-16 place-items-center rounded-lg p-1 hover:bg-white/10"
    >
      {state.status === "ready" ? (
        <img src={state.url} alt="" className="size-full object-contain" draggable={false} />
      ) : (
        <span className="text-[10px] text-slate-500">{state.status === "loading" ? "…" : "🖼️"}</span>
      )}
    </button>
  );
}
