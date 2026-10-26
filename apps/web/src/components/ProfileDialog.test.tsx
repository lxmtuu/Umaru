// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "./ProfileDialog.js";
import { useChat } from "../lib/chatStore.js";
import { useLocale } from "../lib/i18n.js";
import type { PushStatus } from "../lib/push.js";

/**
 * Hộp thoại hồ sơ — phần **thông báo đẩy**, chỗ người dùng thật sự bật/tắt.
 *
 * Test này render component với store thật (zustand, chỉ `setState` các trường
 * cần) nên kiểm được đúng thứ người dùng thấy: hộp kiểm có bị khoá không, dòng
 * gợi ý nào hiện, nút "Gửi thử" có xuất hiện không, và bấm thì gọi hành động nào.
 */

afterEach(cleanup);

const actions = {
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  testPush: vi.fn(),
};

function setState(patch: Partial<ReturnType<typeof useChat.getState>>): void {
  useChat.setState(patch as never);
}

function setup(pushStatus: PushStatus, extra: Partial<ReturnType<typeof useChat.getState>> = {}) {
  setState({
    me: {
      id: "u1",
      username: "demo_user",
      displayName: "Demo",
      avatarUrl: null,
    } as never,
    avatarUploading: false,
    avatarError: null,
    uploadAvatar: vi.fn(async () => true),
    removeAvatar: vi.fn(async () => true),
    clearAvatarError: vi.fn(),
    notificationSettings: { desktop: false, tabTitle: true },
    notificationPermission: "default",
    setDesktopNotifications: vi.fn(),
    setTabTitleNotifications: vi.fn(),
    pushStatus,
    selfStatus: "online",
    setPresence: vi.fn(),
    pushBusy: false,
    pushNotice: null,
    ...actions,
    ...extra,
  });
  render(<ProfileDialog onClose={() => undefined} />);
}

beforeEach(() => {
  useLocale.setState({ locale: "vi" });
  actions.enablePush.mockClear();
  actions.disablePush.mockClear();
  actions.testPush.mockClear();
});

describe("ProfileDialog — thông báo đẩy", () => {
  it("trạng thái tắt: hộp kiểm trống, gợi ý nói rõ chỉ nhận khi app mở", () => {
    setup("off");
    const checkbox = screen.getByRole("checkbox", { name: /Bật thông báo đẩy/ });
    expect(checkbox).toHaveProperty("checked", false);
    expect(screen.getByText(/chỉ nhận thông báo khi Umaru còn mở/)).toBeTruthy();
    // Chưa bật thì không có gì để gửi thử.
    expect(screen.queryByText("Gửi thử")).toBeNull();
  });

  it("bấm hộp kiểm gọi enablePush (và không gọi disablePush)", () => {
    setup("off");
    fireEvent.click(screen.getByRole("checkbox", { name: /Bật thông báo đẩy/ }));
    expect(actions.enablePush).toHaveBeenCalledTimes(1);
    expect(actions.disablePush).not.toHaveBeenCalled();
  });

  it("trình duyệt chặn quyền: hộp kiểm vẫn bấm được và hiện đường sửa", () => {
    // Cố ý KHÔNG khoá: người dùng cần thấy lý do và bấm lại sau khi đổi cài
    // đặt trang. Khoá im lặng thì họ không biết phải làm gì.
    setup("blocked");
    const checkbox = screen.getByRole("checkbox", { name: /Bật thông báo đẩy/ });
    expect(checkbox).toHaveProperty("disabled", false);
    expect(screen.getByText(/mở cài đặt trang để cho phép/)).toBeTruthy();
  });

  it("server chưa cấu hình VAPID: khoá hộp kiểm, nói rõ là lỗi phía server", () => {
    setup("unavailable");
    const checkbox = screen.getByRole("checkbox", { name: /Bật thông báo đẩy/ });
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByText(/Server chưa bật thông báo đẩy/)).toBeTruthy();
  });

  it("trình duyệt không hỗ trợ: khoá hộp kiểm và nói rõ", () => {
    setup("unsupported");
    expect(screen.getByRole("checkbox", { name: /Bật thông báo đẩy/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/không hỗ trợ thông báo đẩy/)).toBeTruthy();
  });

  it("đang bật: hộp kiểm đã chọn, hiện nút Gửi thử và bấm thì gọi testPush", () => {
    setup("on");
    expect(screen.getByRole("checkbox", { name: /Tắt/ })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByText("Gửi thử"));
    expect(actions.testPush).toHaveBeenCalledTimes(1);
  });

  it("bỏ chọn khi đang bật thì gọi disablePush", () => {
    setup("on");
    fireEvent.click(screen.getByRole("checkbox", { name: /Tắt/ }));
    expect(actions.disablePush).toHaveBeenCalledTimes(1);
  });

  it("đang xử lý: hộp kiểm và nút Gửi thử cùng bị khoá (không bấm hai lần)", () => {
    setup("on", { pushBusy: true });
    expect(screen.getByRole("checkbox", { name: /Tắt/ })).toHaveProperty("disabled", true);
    expect(screen.getByText("Đang xử lý…")).toBeTruthy();
  });

  it("có kết quả gửi thử thì hiện ngay dưới nút", () => {
    setup("on", { pushNotice: "Đã gửi thử — vài giây nữa sẽ tới." });
    expect(screen.getByText(/Đã gửi thử/)).toBeTruthy();
  });
});

describe("ProfileDialog — thông báo trình duyệt (khi tab mở)", () => {
  it("bị chặn quyền thì hộp kiểm thông báo desktop bị khoá, và nói lý do", () => {
    setup("off", { notificationPermission: "denied" });
    const desktop = screen.getByRole("checkbox", { name: /Thông báo trên máy/ });
    expect(desktop).toHaveProperty("disabled", true);
    expect(screen.getByText(/Trình duyệt đang chặn/)).toBeTruthy();
  });

  it("bật thông báo desktop gọi setDesktopNotifications", () => {
    const setDesktop = vi.fn();
    setup("off", { setDesktopNotifications: setDesktop });
    fireEvent.click(screen.getByRole("checkbox", { name: /Thông báo trên máy/ }));
    expect(setDesktop).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileDialog — trạng thái hiển thị", () => {
  it("bốn lựa chọn trạng thái, mặc định Trực tuyến đang được chọn", () => {
    setup("off");
    const online = screen.getByRole("button", { name: /Trực tuyến/ });
    expect(online.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Đang chờ/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: /Không làm phiền/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ẩn/ })).toBeTruthy();
  });

  it("bấm một trạng thái gọi setPresence với đúng giá trị", () => {
    const setPresence = vi.fn();
    setup("off", { setPresence } as never);
    fireEvent.click(screen.getByRole("button", { name: /Không làm phiền/ }));
    expect(setPresence).toHaveBeenCalledWith("dnd");
  });

  it("đang ẩn thì nút Ẩn được đánh dấu, không phải Trực tuyến", () => {
    setup("off", { selfStatus: "offline" } as never);
    expect(screen.getByRole("button", { name: /^Ẩn$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Trực tuyến/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("ProfileDialog — tuỳ chọn hiển thị", () => {
  it("hộp kiểm 'Chế độ thu gọn' phản ánh state và bấm thì gọi setCompactMode", () => {
    const setCompactMode = vi.fn();
    setup("off", { displaySettings: { compact: false }, setCompactMode } as never);
    const box = screen.getByRole("checkbox", { name: /Chế độ thu gọn/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    expect(setCompactMode).toHaveBeenCalledWith(true);
  });

  it("đang bật sẵn thì hộp kiểm đã tick (không hiển thị sai trạng thái)", () => {
    setup("off", { displaySettings: { compact: true }, setCompactMode: vi.fn() } as never);
    expect(
      (screen.getByRole("checkbox", { name: /Chế độ thu gọn/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});
