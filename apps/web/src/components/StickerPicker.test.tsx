// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StickerPack } from "@umaru/protocol";

/**
 * Bảng chọn sticker.
 *
 * Trọng tâm: bấm sticker phải trả đúng sticker cho ô soạn tin, phần quản lý chỉ
 * hiện với người có quyền, và server chưa có gói thì phải có câu giải thích
 * chứ không phải khung trống.
 */

const state = vi.hoisted(() => ({
  stickerPacks: {} as Record<string, StickerPack[] | null>,
  stickerBusy: false,
  stickerError: null as string | null,
  loadStickerPacks: vi.fn(async () => undefined),
  createStickerPack: vi.fn(async () => true),
  deleteStickerPack: vi.fn(async () => true),
  uploadSticker: vi.fn(async () => true),
  deleteSticker: vi.fn(async () => true),
  clearStickerError: vi.fn(),
}));

vi.mock("../lib/chatStore.js", () => ({
  // Selector nhận nguyên state giả — đủ để component đọc đúng trường.
  useChat: (selector: (value: typeof state) => unknown) => selector(state),
}));

vi.mock("../lib/stickers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stickers.js")>();
  return {
    ...actual,
    // Không tải ảnh thật trong jsdom; chỉ cần trạng thái "đã có ảnh".
    useStickerUrl: () => ({ status: "ready", url: "data:image/png;base64,iVBORw0KGgo=" }),
  };
});

const { StickerPicker } = await import("./StickerPicker.js");

afterEach(() => {
  cleanup();
  state.stickerPacks = {};
  state.stickerError = null;
  state.loadStickerPacks.mockClear();
});

function pack(overrides: Partial<StickerPack> = {}): StickerPack {
  return {
    id: "10" as StickerPack["id"],
    guildId: "1" as StickerPack["guildId"],
    name: "Biểu cảm",
    createdBy: "2" as StickerPack["createdBy"],
    stickers: [
      {
        id: "20" as never,
        packId: "10" as never,
        name: "Vẫy tay",
        imageUrl: "/api/v1/guilds/1/stickers/20/image",
        mimeType: "image/png",
        width: 64,
        height: 64,
      },
    ],
    ...overrides,
  };
}

describe("StickerPicker", () => {
  it("hiện gói + sticker và trả sticker khi bấm", () => {
    state.stickerPacks = { "1": [pack()] };
    const onPick = vi.fn();
    render(<StickerPicker guildId="1" canManage={false} onPick={onPick} onClose={() => undefined} />);

    expect(screen.getByText("Biểu cảm · 1")).toBeTruthy();
    screen.getByLabelText("Vẫy tay").click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toMatchObject({ id: "20", name: "Vẫy tay" });
  });

  it("tải danh sách mỗi lần mở", () => {
    state.stickerPacks = { "1": [] };
    render(<StickerPicker guildId="1" canManage={false} onPick={() => undefined} onClose={() => undefined} />);
    expect(state.loadStickerPacks).toHaveBeenCalledWith("1");
  });

  it("server chưa có gói: người thường thấy câu trống, không thấy nút quản lý", () => {
    state.stickerPacks = { "1": [] };
    const { rerender } = render(
      <StickerPicker guildId="1" canManage={false} onPick={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getByText("This server has no stickers yet.")).toBeTruthy();
    expect(screen.queryByText("New pack")).toBeNull();

    rerender(
      <StickerPicker guildId="1" canManage onPick={() => undefined} onClose={() => undefined} />,
    );
    expect(
      screen.getByText(/No sticker packs yet/),
    ).toBeTruthy();
    expect(screen.getByText("New pack")).toBeTruthy();
  });

  it("người quản lý thấy nút tải sticker và xoá gói", () => {
    state.stickerPacks = { "1": [pack()] };
    render(<StickerPicker guildId="1" canManage onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Upload sticker")).toBeTruthy();
    expect(screen.getByText("Delete pack")).toBeTruthy();
  });

  it("lỗi từ store hiện kèm nút đóng", () => {
    state.stickerPacks = { "1": [] };
    state.stickerError = "Gói này đang được dùng";
    render(<StickerPicker guildId="1" canManage onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Gói này đang được dùng")).toBeTruthy();
  });
});
