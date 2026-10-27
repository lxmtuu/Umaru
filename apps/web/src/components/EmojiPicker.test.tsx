// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMOJI_GROUPS, EmojiPicker } from "./EmojiPicker.js";

afterEach(cleanup);

const groups = [
  { label: "Cảm xúc", emojis: ["👍", "🙏"] },
  { label: "Mặt", emojis: ["😀", "😂"] },
];

describe("EmojiPicker", () => {
  it("render đủ nhóm và emoji", () => {
    render(<EmojiPicker groups={groups} label="Bảng emoji" onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Bảng emoji" })).toBeTruthy();
    expect(screen.getByText("Cảm xúc")).toBeTruthy();
    expect(screen.getByRole("button", { name: "😂" })).toBeTruthy();
  });

  it("bấm emoji thì báo về ký tự đó", () => {
    const picked: string[] = [];
    render(
      <EmojiPicker groups={groups} label="Bảng emoji" onPick={(e) => picked.push(e)} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "🙏" }));
    expect(picked).toEqual(["🙏"]);
  });

  it("Escape và bấm ra ngoài đều đóng", () => {
    const onClose = vi.fn();
    render(<EmojiPicker groups={groups} label="Bảng emoji" onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Bấm **trong** bảng thì không đóng (nếu không thì không chọn được gì).
    onClose.mockClear();
    fireEvent.mouseDown(screen.getByText("Mặt"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cuộn trang thì đóng (bảng 'trôi' khỏi nút bấm)", () => {
    const onClose = vi.fn();
    render(<EmojiPicker groups={groups} label="Bảng emoji" onPick={() => {}} onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("bộ emoji mặc định không có ký tự trùng trong cùng nhóm", () => {
    // Trùng key trong một nhóm làm React cảnh báo và một nút không bấm được.
    for (const group of DEFAULT_EMOJI_GROUPS) {
      expect(new Set(group.emojis).size).toBe(group.emojis.length);
    }
    expect(DEFAULT_EMOJI_GROUPS.length).toBeGreaterThanOrEqual(4);
  });
});
