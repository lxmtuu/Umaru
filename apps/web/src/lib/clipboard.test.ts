// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard.js";

/**
 * Clipboard: ba đường — Clipboard API chạy được, Clipboard API hỏng (rơi xuống
 * `execCommand`), và cả hai hỏng. Hàm phải **nói thật** kết quả để UI không
 * hiện "Đã sao chép" khi thực ra chưa chép gì.
 */

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  if (originalClipboard === undefined) {
    // jsdom không có navigator.clipboard: xoá hẳn sau mỗi test.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
  vi.restoreAllMocks();
});

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("copyToClipboard", () => {
  it("dùng Clipboard API khi có", async () => {
    const written: string[] = [];
    setClipboard(async (text) => {
      written.push(text);
    });
    await expect(copyToClipboard("xin chào")).resolves.toBe(true);
    expect(written).toEqual(["xin chào"]);
  });

  it("Clipboard API bị từ chối → rơi xuống execCommand và vẫn báo thành công", async () => {
    setClipboard(async () => {
      throw new Error("NotAllowedError");
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    await expect(copyToClipboard("dự phòng")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("không có Clipboard API và execCommand trả false → báo thất bại", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => false),
      configurable: true,
    });

    await expect(copyToClipboard("hỏng")).resolves.toBe(false);
  });

  it("không để lại textarea tạm trong DOM sau khi chép", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => true),
      configurable: true,
    });

    await copyToClipboard("dọn dẹp");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
