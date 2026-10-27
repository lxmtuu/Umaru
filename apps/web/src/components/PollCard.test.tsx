// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Poll } from "@umaru/protocol";

/**
 * Khung bình chọn.
 *
 * Trọng tâm là **ý định gửi lên server** khi bấm, không phải màu thanh kết quả:
 * poll "chọn một" gửi thêm id là 400, còn bấm lại đúng lựa chọn đang chọn thì
 * phải rút phiếu — nếu không thì không có đường nào bỏ phiếu.
 */

const votePoll = vi.hoisted(() => vi.fn(async () => true));
const setState = vi.hoisted(() => ({ pollBusy: null as string | null }));

vi.mock("../lib/session.js", () => ({
  api: {},
  authedApi: {},
  clearTokens: () => undefined,
  getAccessToken: () => "tok",
  getRefreshToken: () => null,
  refreshSession: async () => false,
  storeTokens: () => undefined,
}));

vi.mock("zustand", async () => {
  const actual = await vi.importActual<typeof import("zustand")>("zustand");
  return { ...actual, create: actual.create };
});

const MESSAGE = { id: "500", channelId: "100", authorId: "1" } as unknown as Message;

function poll(overrides: Partial<Poll> = {}): Poll {
  return {
    question: "Ăn gì trưa nay?",
    allowMultiple: false,
    totalVotes: 4,
    expiresAt: null,
    ended: false,
    options: [
      { id: "201" as never, label: "Phở", votes: 3, me: true },
      { id: "202" as never, label: "Cơm tấm", votes: 1, me: false },
      { id: "203" as never, label: "Bún chả", votes: 0, me: false },
    ],
    ...overrides,
  };
}

async function setup(data: Poll) {
  const { PollCard } = await import("./PollCard.js");
  const { useChat } = await import("../lib/chatStore.js");
  useChat.setState({ votePoll, pollBusy: setState.pollBusy } as never);
  render(<PollCard message={MESSAGE} poll={data} />);
}

beforeEach(() => {
  votePoll.mockClear();
  setState.pollBusy = null;
});

afterEach(() => {
  cleanup();
});

describe("PollCard", () => {
  it("hiện câu hỏi, các lựa chọn, số phiếu và phần trăm", async () => {
    await setup(poll());
    expect(screen.getByText("Ăn gì trưa nay?")).toBeDefined();
    // 3/4 = 75%, 1/4 = 25%.
    expect(screen.getByText("3 · 75%")).toBeDefined();
    expect(screen.getByText("1 · 25%")).toBeDefined();
    expect(screen.getByText("0 · 0%")).toBeDefined();
    expect(screen.getByText(/4 lượt bình chọn|4 votes/)).toBeDefined();
  });

  it("bấm lựa chọn khác trong poll chọn một ⇒ gửi đúng một id (server tự thay phiếu)", async () => {
    await setup(poll());
    fireEvent.click(screen.getByRole("button", { name: /Cơm tấm/ }));
    await waitFor(() => expect(votePoll).toHaveBeenCalledWith("500", ["202"]));
  });

  it("bấm lại lựa chọn đang chọn ⇒ gửi mảng rỗng để rút phiếu", async () => {
    await setup(poll());
    fireEvent.click(screen.getByRole("button", { name: /Phở/ }));
    await waitFor(() => expect(votePoll).toHaveBeenCalledWith("500", []));
  });

  it("poll chọn nhiều: bật thêm lựa chọn, không mất phiếu cũ; bỏ chọn thì chỉ còn lại", async () => {
    await setup(poll({ allowMultiple: true }));
    fireEvent.click(screen.getByRole("button", { name: /Cơm tấm/ }));
    await waitFor(() => expect(votePoll).toHaveBeenLastCalledWith("500", ["201", "202"]));

    cleanup();
    const { PollCard } = await import("./PollCard.js");
    render(
      <PollCard
        message={MESSAGE}
        poll={poll({
          allowMultiple: true,
          options: [
            { id: "201" as never, label: "Phở", votes: 3, me: true },
            { id: "202" as never, label: "Cơm tấm", votes: 1, me: true },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Phở/ }));
    await waitFor(() => expect(votePoll).toHaveBeenLastCalledWith("500", ["202"]));
  });

  it("poll đã kết thúc: không bấm được và không gọi API", async () => {
    await setup(poll({ ended: true }));
    const option = screen.getByRole("button", { name: /Cơm tấm/ }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    fireEvent.click(option);
    expect(votePoll).not.toHaveBeenCalled();
    expect(screen.getByText(/đã kết thúc|ended/i)).toBeDefined();
  });

  it("đang gửi phiếu thì khoá nút (chặn bấm liên tiếp trên cùng tin)", async () => {
    setState.pollBusy = "500";
    await setup(poll());
    const option = screen.getByRole("button", { name: /Cơm tấm/ }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
  });
});
