// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceScreens } from "./VoiceScreens.js";
import { useLocale } from "../lib/i18n.js";
import type { VoiceScreenShare } from "../lib/voice.js";

/**
 * Khung xem chia sẻ màn hình. Điểm dễ sai: thẻ `<video>` do LiveKit tạo và đã
 * gắn luồng media, component chỉ được **đưa nó vào DOM** — tạo phần tử mới là
 * mất hình, và không gỡ khi unmount là rò rỉ + video tiếp tục phát tiếng.
 */

afterEach(cleanup);

beforeEach(() => {
  useLocale.setState({ locale: "vi" });
});

function screenShare(id: string, label: string): VoiceScreenShare {
  const element = document.createElement("video");
  element.dataset.track = id;
  // jsdom không có play(); gán để không ném khi component gọi.
  element.play = () => Promise.resolve();
  return { id, userId: "u1", label, element };
}

describe("VoiceScreens", () => {
  it("không có ai chia sẻ: không render gì (không chiếm chỗ trên màn hình)", () => {
    const { container } = render(<VoiceScreens screens={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("đưa đúng thẻ <video> của LiveKit vào DOM, kèm tên người chia sẻ", () => {
    const share = screenShare("t1", "An");
    render(<VoiceScreens screens={[share]} />);
    expect(document.body.contains(share.element)).toBe(true);
    expect(screen.getByText("An")).toBeTruthy();
    expect(screen.getByText("đang chia sẻ màn hình")).toBeTruthy();
  });

  it("hai người cùng chia sẻ: hai khung, hai thẻ khác nhau", () => {
    const a = screenShare("t1", "An");
    const b = screenShare("t2", "Bình");
    render(<VoiceScreens screens={[a, b]} />);
    expect(document.body.contains(a.element)).toBe(true);
    expect(document.body.contains(b.element)).toBe(true);
    expect(document.querySelectorAll("figure")).toHaveLength(2);
  });

  it("người kia dừng chia sẻ: thẻ video bị gỡ khỏi DOM", () => {
    const share = screenShare("t1", "An");
    const { rerender } = render(<VoiceScreens screens={[share]} />);
    expect(document.body.contains(share.element)).toBe(true);
    rerender(<VoiceScreens screens={[]} />);
    expect(document.body.contains(share.element)).toBe(false);
  });

  it("unmount là gỡ hết (không để video tiếp tục phát sau khi rời màn hình)", () => {
    const share = screenShare("t1", "An");
    const { unmount } = render(<VoiceScreens screens={[share]} />);
    unmount();
    expect(document.body.contains(share.element)).toBe(false);
  });
});
