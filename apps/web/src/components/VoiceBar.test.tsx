// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "../lib/i18n.js";
import { VoiceBar, type VoiceBarProps } from "./VoiceBar.js";
import type { VoiceAudioState } from "../lib/voice.js";

/**
 * Test **render thật** cho thanh thoại.
 *
 * Trước file này, toàn bộ UI chưa từng được render ở đâu: 500+ test đều chạy
 * trên Node và chỉ kiểm hàm thuần. Những thứ dưới đây chỉ sai khi có DOM thật —
 * nút bị `disabled` sai, chữ trạng thái không đổi, bấm không gọi handler — và
 * chúng đều là lỗi người dùng nhìn thấy chứ không phải lỗi logic.
 */

afterEach(cleanup);

// Chữ trong thanh thoại là hợp đồng với người dùng cuối (tiếng Việt); test đặt
// locale tường minh thay vì phụ thuộc `navigator.language` của môi trường.
beforeEach(() => {
  useLocale.setState({ locale: "vi" });
});

const audio = (patch: Partial<VoiceAudioState> = {}): VoiceAudioState => ({
  channelId: "c1",
  status: "connected",
  errorKey: null,
  canPublish: true,
  ...patch,
});

function setup(patch: Partial<VoiceBarProps> = {}) {
  const handlers = {
    onLeave: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleDeafen: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onRetry: vi.fn(),
  };
  const props: VoiceBarProps = {
    channelName: "Phòng smoke",
    selfMute: false,
    selfDeaf: false,
    voiceAudio: audio(),
    speakers: [],
    meId: "u1",
    screenSharing: false,
    ...handlers,
    ...patch,
  };
  render(<VoiceBar {...props} />);
  return handlers;
}

describe("VoiceBar — trạng thái âm thanh", () => {
  it("đang kết nối: hiện 'đang kết nối', không hiện nút Thử lại", () => {
    setup({ voiceAudio: audio({ status: "connecting" }) });
    expect(screen.getByTestId("voice-status").textContent).toContain("Đang kết nối");
    expect(screen.queryByText("Thử lại")).toBeNull();
  });

  it("đang nối lại sau khi mất mạng: chữ khác hẳn 'đang kết nối'", () => {
    // Cùng một dòng chữ cho hai tình huống rất khác nhau (vào phòng lần đầu vs
    // rớt mạng giữa cuộc) sẽ khiến người dùng tưởng app treo.
    setup({ voiceAudio: audio({ status: "reconnecting" }) });
    expect(screen.getByTestId("voice-status").textContent).toContain("Đang nối lại");
  });

  it("đã thông và có quyền nói: hiện 'Đang thông'", () => {
    setup();
    expect(screen.getByTestId("voice-status").textContent).toContain("Đang thông");
  });

  it("đã thông nhưng mình đang nói: nhãn đổi sang 'Đang nói'", () => {
    setup({ speakers: ["u1"] });
    expect(screen.getByTestId("voice-status").textContent).toContain("Đang nói");
  });

  it("thiếu SPEAK: ghi rõ 'chỉ nghe được' và nút chia sẻ màn hình bị khoá", () => {
    setup({ voiceAudio: audio({ canPublish: false }) });
    expect(screen.getByTestId("voice-status").textContent).toContain("chỉ nghe được");
    expect(screen.getByRole("button", { name: "Chia sẻ màn hình" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("server chưa bật âm thanh: hiện thông báo nhưng KHÔNG có nút Thử lại", () => {
    // Thử lại không chữa được cấu hình server — để nút đó là bắt người dùng bấm
    // mãi vào một thứ không bao giờ thành công.
    const handlers = setup({
      voiceAudio: audio({ status: "unavailable", errorKey: "voiceErrorNotConfigured" }),
    });
    expect(screen.getByTestId("voice-status").textContent).toContain("chưa bật âm thanh");
    expect(screen.queryByText("Thử lại")).toBeNull();
    expect(handlers.onRetry).not.toHaveBeenCalled();
  });

  it("lỗi mic bị chặn: hiện lý do và nút Thử lại gọi đúng handler", () => {
    const handlers = setup({
      voiceAudio: audio({ status: "error", errorKey: "voiceErrorMicDenied" }),
    });
    expect(screen.getByTestId("voice-status").textContent).toContain("chặn micro");
    fireEvent.click(screen.getByText("Thử lại"));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it("lỗi mà không có errorKey vẫn có chữ (không hiện khoá i18n thô)", () => {
    setup({ voiceAudio: audio({ status: "error", errorKey: null }) });
    const text = screen.getByTestId("voice-status").textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("voiceError");
  });
});

describe("VoiceBar — nút bấm", () => {
  it("mic/tai nghe/chia sẻ/rời phòng đều gọi đúng handler", () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "Tắt mic" }));
    fireEvent.click(screen.getByRole("button", { name: "Tắt tai nghe" }));
    fireEvent.click(screen.getByRole("button", { name: "Chia sẻ màn hình" }));
    fireEvent.click(screen.getByRole("button", { name: "Rời kênh thoại" }));
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleDeafen).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleScreenShare).toHaveBeenCalledTimes(1);
    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
  });

  it("đang chia sẻ: nút đổi nhãn sang 'Dừng chia sẻ' và có aria-pressed", () => {
    setup({ screenSharing: true });
    const button = screen.getByRole("button", { name: "Dừng chia sẻ" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("đang mute: nút mic có aria-pressed và nhãn là 'Bật tiếng'", () => {
    setup({ selfMute: true });
    const button = screen.getByRole("button", { name: "Bật mic" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("🔇");
  });

  it("đang nói: nút mic có đánh dấu để UI tô vòng xanh", () => {
    setup({ speakers: ["u1"] });
    expect(
      screen.getByRole("button", { name: "Tắt mic" }).getAttribute("data-speaking"),
    ).toBe("true");
  });

  it("đang nối lại vẫn cho bấm chia sẻ (phiên chưa chết, chỉ mạng chập)", () => {
    setup({ voiceAudio: audio({ status: "reconnecting" }) });
    expect(screen.getByRole("button", { name: "Chia sẻ màn hình" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
