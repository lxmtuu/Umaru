// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent.js";

/**
 * Tương tác của spoiler (`||...||`): bấm để hiện, bấm lại để che.
 *
 * Kiểm riêng khỏi `MessageContent.test.tsx` (chỗ đó render tĩnh) vì đây là
 * hành vi có trạng thái — và là toàn bộ giá trị của tính năng.
 */

afterEach(cleanup);

describe("spoiler bấm để hiện", () => {
  it("bấm lần đầu hiện chữ, bấm lần nữa che lại", () => {
    render(<MessageContent content="trước ||bí mật|| sau" />);
    const button = screen.getByRole("button", { name: "Reveal spoiler" });

    // Đang che: chữ nằm trong DOM nhưng bị làm trong suốt.
    expect(button.className).toContain("text-transparent");
    expect(button.textContent).toBe("bí mật");

    fireEvent.click(button);
    expect(button.className).not.toContain("text-transparent");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide spoiler" })).toBeTruthy();

    fireEvent.click(button);
    expect(button.className).toContain("text-transparent");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("nhiều spoiler trong một tin mở độc lập nhau", () => {
    render(<MessageContent content="||một|| và ||hai||" />);
    const buttons = screen.getAllByRole("button", { name: "Reveal spoiler" });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]!);
    expect(buttons[0]!.className).not.toContain("text-transparent");
    // Cái thứ hai vẫn che — không có state dùng chung.
    expect(buttons[1]!.className).toContain("text-transparent");
  });

  it("chữ thường quanh spoiler vẫn hiện", () => {
    const { container } = render(<MessageContent content="trước ||che|| sau" />);
    expect(container.textContent).toBe("trước che sau");
  });
});
