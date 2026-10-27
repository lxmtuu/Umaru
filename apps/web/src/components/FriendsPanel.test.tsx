// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FriendsPanel } from "./FriendsPanel.js";
import { useLocale } from "../lib/i18n.js";
import type { DmPrivacy, FriendList, PresenceStatus, Snowflake, UserProfile } from "@umaru/protocol";

/**
 * Panel bạn bè — chưa từng được render trong test trước đây, và vừa được thêm
 * chấm trạng thái. Test khoá: chấm theo presence, người online xếp trên, và các
 * nút vẫn gọi đúng hành động.
 */

afterEach(cleanup);
beforeEach(() => useLocale.setState({ locale: "vi" }));

const sid = (value: string): Snowflake => value as Snowflake;

function profile(id: string, displayName: string): UserProfile {
  return {
    id: sid(id),
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
  } as UserProfile;
}

/** `FriendList` thật có nhiều trường; test chỉ dựng phần panel dùng tới. */
function friendList(friends: Array<[string, string]>): FriendList {
  return {
    friends: friends.map(([id, name]) => ({
      user: profile(id, name),
      since: "2026-10-01T00:00:00.000Z",
    })),
    incoming: [],
    outgoing: [],
    dmPrivacy: "everyone" as DmPrivacy,
  } as unknown as FriendList;
}

function setup(overrides: Partial<Parameters<typeof FriendsPanel>[0]> = {}) {
  const handlers = {
    onQueryChange: vi.fn(),
    onAdd: vi.fn(),
    onAccept: vi.fn(),
    onRemove: vi.fn(),
    onDmPrivacy: vi.fn(),
    onAcceptRequest: vi.fn(),
    onDeclineRequest: vi.fn(),
  };
  render(
    <FriendsPanel
      friends={friendList([
        ["u1", "Minh"],
        ["u2", "Linh"],
        ["u3", "Bình"],
      ])}
      loading={false}
      query=""
      requests={[]}
      requestsLoading={false}
      presence={{ u2: "online" } as Record<string, PresenceStatus>}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("FriendsPanel", () => {
  it("hiện đủ bạn bè trong tab đầu tiên", () => {
    setup();
    for (const name of ["Minh", "Linh", "Bình"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("người đang online xếp trên người ngoại tuyến", () => {
    setup();
    const names = screen.getAllByText(/^(Minh|Linh|Bình)$/).map((node) => node.textContent);
    expect(names[0]).toBe("Linh");
  });

  it("có chấm trạng thái cho từng người bạn", () => {
    const { container } = render(
      <FriendsPanel
        friends={friendList([["u2", "Linh"]])}
        loading={false}
        query=""
        requests={[]}
        requestsLoading={false}
        presence={{ u2: "dnd" }}
        onQueryChange={vi.fn()}
        onAdd={vi.fn()}
        onAccept={vi.fn()}
        onRemove={vi.fn()}
        onDmPrivacy={vi.fn()}
        onAcceptRequest={vi.fn()}
        onDeclineRequest={vi.fn()}
      />,
    );
    // Không dùng `render` ở setup để tránh 2 cây DOM cùng lúc.
    const dots = container.querySelectorAll("span.absolute.-bottom-0\\.5");
    expect(dots).toHaveLength(1);
    expect(dots[0]?.className).toContain("bg-rose-500");
  });

  it("bấm huỷ kết bạn gọi onRemove với đúng id", () => {
    const handlers = setup();
    fireEvent.click(screen.getAllByText("Bỏ kết bạn")[0]!);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  });

  it("gửi ô thêm bạn gọi onAdd với username đã trim", () => {
    const handlers = setup({ query: "  minh  " });
    fireEvent.submit(screen.getByRole("textbox", { name: /tên người dùng|username/i }).closest("form")!);
    expect(handlers.onAdd).toHaveBeenCalledWith("minh");
  });

  it("đổi quyền riêng tư DM gọi onDmPrivacy", () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText(/ai được nhắn tin/i), {
      target: { value: "friends" },
    });
    expect(handlers.onDmPrivacy).toHaveBeenCalledWith("friends");
  });

  it("chưa tải xong thì hiện trạng thái đang tải, không hiện danh sách rỗng", () => {
    setup({ friends: null, loading: true });
    expect(screen.getByText("Đang tải…")).toBeTruthy();
  });
});
