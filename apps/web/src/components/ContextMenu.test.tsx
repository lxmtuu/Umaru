// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";

/**
 * Menu chuột phải: test hành vi, không test CSS.
 *
 * Bốn thứ dưới đây là lý do component này tồn tại (xem docstring): lật khi tràn
 * màn hình, đóng đúng lúc, điều hướng bằng bàn phím, và đóng **trước** khi chạy
 * hành động.
 */

afterEach(cleanup);

function items(calls: string[]): ContextMenuItem[] {
  return [
    { id: "reply", label: "Trả lời", icon: "↩", onSelect: () => calls.push("reply") },
    { id: "copy", label: "Sao chép nội dung", icon: "📋", onSelect: () => calls.push("copy") },
    {
      id: "delete",
      label: "Xoá",
      icon: "🗑",
      danger: true,
      onSelect: () => calls.push("delete"),
    },
  ];
}

describe("ContextMenu", () => {
  it("render đủ mục theo thứ tự, có role menu/menuitem", () => {
    render(<ContextMenu x={10} y={10} items={items([])} label="Hành động" onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: "Hành động" });
    const labels = screen.getAllByRole("menuitem").map((element) => element.textContent);
    expect(labels).toEqual(["↩Trả lời", "📋Sao chép nội dung", "🗑Xoá"]);
    expect(menu.getAttribute("data-testid")).toBe("context-menu");
  });

  it("bấm một mục: chạy hành động rồi đóng menu", () => {
    const calls: string[] = [];
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items(calls)} label="Hành động" onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Sao chép nội dung/ }));
    expect(calls).toEqual(["copy"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape đóng menu", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items([])} label="Hành động" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("bấm ra ngoài đóng, bấm bên trong thì không", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items([])} label="Hành động" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: /Trả lời/ }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cuộn trang thì đóng (menu 'trôi' khỏi chỗ vừa bấm là lỗi khó hiểu)", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items([])} label="Hành động" onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mục đầu được focus, ArrowDown/ArrowUp/Home/End đi vòng đúng", () => {
    render(<ContextMenu x={0} y={0} items={items([])} label="Hành động" onClose={() => {}} />);
    const buttons = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(document, { key: "End" });
    expect(document.activeElement).toBe(buttons[2]);
    // Xuống ở mục cuối thì quay về đầu (giống menu native).
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(document, { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("mở gần mép phải/dưới thì lật vào trong màn hình", () => {
    // jsdom trả kích thước 0 cho mọi phần tử; ép menu có kích thước thật để
    // kiểm phần lật — đây là hành vi duy nhất phụ thuộc số đo.
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        width: 200,
        height: 150,
        top: 0,
        left: 0,
        right: 200,
        bottom: 150,
        toJSON: () => ({}),
      } as DOMRect);
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });

    try {
      render(<ContextMenu x={380} y={280} items={items([])} label="Hành động" onClose={() => {}} />);
      const menu = screen.getByTestId("context-menu");
      // 380 + 200 > 400 → lật sang trái: 380 - 200 = 180.
      expect(menu.style.left).toBe("180px");
      // 280 + 150 > 300 → lật lên trên: 280 - 150 = 130.
      expect(menu.style.top).toBe("130px");
    } finally {
      spy.mockRestore();
    }
  });

  it("danh sách rỗng thì không render gì (không để lại menu trống)", () => {
    const { container } = render(
      <ContextMenu x={0} y={0} items={[]} label="Hành động" onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });
});
