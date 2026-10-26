import { describe, expect, it } from "vitest";
import type { Poll } from "@umaru/protocol";
import { nextVoteSelection, pollPercent, pollTimeLeft } from "./poll.js";

function poll(overrides: Partial<Poll> = {}): Poll {
  return {
    question: "Q",
    allowMultiple: false,
    totalVotes: 0,
    expiresAt: null,
    ended: false,
    options: [
      { id: "1" as never, label: "A", votes: 0, me: false },
      { id: "2" as never, label: "B", votes: 0, me: false },
    ],
    ...overrides,
  };
}

describe("pollPercent", () => {
  it("làm tròn xuống và không chia cho 0", () => {
    expect(pollPercent(1, 3)).toBe(33);
    expect(pollPercent(0, 0)).toBe(0);
    expect(pollPercent(3, 3)).toBe(100);
  });

  it("không vượt 100 khi dữ liệu lệch (một người chọn nhiều đáp án)", () => {
    // 3 người, totalVotes=2 (2 người bỏ phiếu) nhưng một đáp án có 3 phiếu là
    // không thể — vẫn phải kẹp lại, thà hiện 100% còn hơn thanh tràn khung.
    expect(pollPercent(3, 2)).toBe(100);
  });
});

describe("nextVoteSelection", () => {
  it("chọn một: chọn mới thay phiếu cũ", () => {
    expect(nextVoteSelection(poll(), "2")).toEqual(["2"]);
  });

  it("chọn một: bấm lại lựa chọn đang chọn ⇒ rút phiếu", () => {
    const current = poll({
      options: [
        { id: "1" as never, label: "A", votes: 1, me: true },
        { id: "2" as never, label: "B", votes: 0, me: false },
      ],
    });
    expect(nextVoteSelection(current, "1")).toEqual([]);
  });

  it("chọn nhiều: cộng thêm, giữ phiếu cũ", () => {
    const current = poll({
      allowMultiple: true,
      options: [
        { id: "1" as never, label: "A", votes: 1, me: true },
        { id: "2" as never, label: "B", votes: 0, me: false },
      ],
    });
    expect(nextVoteSelection(current, "2")).toEqual(["1", "2"]);
  });

  it("chọn nhiều: bấm lại thì bỏ đúng lựa chọn đó", () => {
    const current = poll({
      allowMultiple: true,
      options: [
        { id: "1" as never, label: "A", votes: 1, me: true },
        { id: "2" as never, label: "B", votes: 1, me: true },
      ],
    });
    expect(nextVoteSelection(current, "1")).toEqual(["2"]);
  });

  it("poll đã kết thúc: trả nguyên trạng, không sinh request chắc chắn 400", () => {
    const ended = poll({ ended: true });
    expect(nextVoteSelection(ended, "2")).toEqual([]);
  });
});

describe("pollTimeLeft", () => {
  const now = new Date("2026-10-27T10:00:00.000Z").getTime();

  it("không hạn", () => {
    expect(pollTimeLeft(poll(), now)).toEqual({ kind: "none" });
  });

  it("còn phút (làm tròn lên, tối thiểu 1)", () => {
    expect(pollTimeLeft(poll({ expiresAt: "2026-10-27T10:30:00.000Z" }), now)).toEqual({
      kind: "left",
      minutes: 30,
    });
    expect(pollTimeLeft(poll({ expiresAt: "2026-10-27T10:00:10.000Z" }), now)).toEqual({
      kind: "left",
      minutes: 1,
    });
  });

  it("đã qua mốc hạn ⇒ ended, kể cả khi server chưa kịp đánh dấu", () => {
    expect(pollTimeLeft(poll({ expiresAt: "2026-10-27T09:59:00.000Z" }), now)).toEqual({
      kind: "ended",
    });
  });
});
