// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicProfile } from "@umaru/protocol";

/**
 * Thẻ hồ sơ người khác.
 *
 * Trọng tâm: 404 phải hiện thông báo **riêng tư**, không phải lỗi mạng — server
 * cố tình không phân biệt "không có liên hệ" với "id không tồn tại".
 */

const getPublicProfile = vi.hoisted(() => vi.fn());

vi.mock("../lib/session.js", () => ({
  api: {},
  authedApi: { getPublicProfile },
  clearTokens: () => undefined,
  getAccessToken: () => "tok",
  getRefreshToken: () => null,
  refreshSession: async () => false,
  storeTokens: () => undefined,
}));

// Avatar tự tải ảnh qua Bearer; ở đây không kiểm phần đó, chỉ cần nó render.
vi.mock("../lib/avatars.js", () => ({
  clearAvatarCache: () => undefined,
  validateAvatar: () => null,
  useAvatarUrl: () => ({ status: "idle", url: null }),
}));

const { UserProfileCard } = await import("./UserProfileCard.js");
const { ApiError } = await import("@umaru/sdk");

afterEach(() => {
  cleanup();
  getPublicProfile.mockReset();
});

function profile(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    id: "42" as PublicProfile["id"],
    username: "alice",
    displayName: "Alice",
    avatarUrl: null,
    bio: "Thích cà phê Đà Lạt",
    pronouns: "cô ấy",
    bannerColor: "#10b981",
    createdAt: "2025-01-02T03:04:05.000Z",
    ...overrides,
  };
}

describe("UserProfileCard", () => {
  it("hiện tên, đại từ và giới thiệu khi tải được", async () => {
    getPublicProfile.mockResolvedValue(profile());
    render(<UserProfileCard userId="42" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
    expect(screen.getByText("@alice")).toBeTruthy();
    expect(screen.getByText("cô ấy")).toBeTruthy();
    expect(screen.getByText("Thích cà phê Đà Lạt")).toBeTruthy();
    expect(getPublicProfile).toHaveBeenCalledWith("42");
  });

  it("giới thiệu trống → hiện câu gợi ý, không phải khoảng trắng", async () => {
    getPublicProfile.mockResolvedValue(profile({ bio: null, pronouns: null }));
    render(<UserProfileCard userId="42" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText("Nothing here yet.")).toBeTruthy());
    expect(screen.queryByText("cô ấy")).toBeNull();
  });

  it("404 → thông báo riêng tư, không phải lỗi", async () => {
    getPublicProfile.mockRejectedValue(new ApiError(404, "không tìm thấy"));
    render(<UserProfileCard userId="42" onClose={() => undefined} />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "You can't view this profile — you need a shared server or a direct connection.",
        ),
      ).toBeTruthy(),
    );
  });

  it("lỗi khác 404 → có nút thử lại", async () => {
    getPublicProfile.mockRejectedValueOnce(new ApiError(500, "server lỗi"));
    render(<UserProfileCard userId="42" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText("This account is no longer available.")).toBeTruthy());
    getPublicProfile.mockResolvedValue(profile());
    screen.getByText("Try again").click();

    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
    expect(getPublicProfile).toHaveBeenCalledTimes(2);
  });

  it("màu banner lạ không lọt vào style", async () => {
    getPublicProfile.mockResolvedValue(profile({ bannerColor: "url(javascript:alert(1))" }));
    const { container } = render(<UserProfileCard userId="42" onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
    const banner = container.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(banner).not.toBeNull();
    // Không set style thì màu rơi về mặc định — quan trọng là **không** chứa chuỗi lạ.
    expect(banner!.getAttribute("style") ?? "").not.toContain("javascript");
  });
});
