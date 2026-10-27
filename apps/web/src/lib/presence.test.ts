import { describe, expect, it } from "vitest";
import { partitionByPresence, presenceOf, sortByPresence, PRESENCE_DOT } from "./presence.js";
import type { GuildMemberSummary, PresenceStatus, Snowflake } from "@umaru/protocol";

const sid = (value: string): Snowflake => value as Snowflake;

function member(id: string, displayName: string): GuildMemberSummary {
  return {
    userId: sid(id),
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    roleIds: [],
  } as GuildMemberSummary;
}

const presence: Record<string, PresenceStatus> = {
  "1": "online",
  "2": "idle",
  "3": "dnd",
  "4": "offline",
};

describe("presenceOf", () => {
  it("không có trong map = offline (không phải 'không rõ')", () => {
    expect(presenceOf(presence, "999")).toBe("offline");
    expect(presenceOf(undefined, "1")).toBe("offline");
  });

  it("đọc đúng trạng thái đã có", () => {
    expect(presenceOf(presence, "1")).toBe("online");
    expect(presenceOf(presence, "3")).toBe("dnd");
  });
});

describe("partitionByPresence", () => {
  it("tách online và offline, giữ nguyên thứ tự trong mỗi nhóm", () => {
    const result = partitionByPresence(
      [member("1", "An"), member("4", "Bình"), member("2", "Cường"), member("999", "Dũng")],
      presence,
    );
    expect(result.online.map((m) => m.displayName)).toEqual(["An", "Cường"]);
    // Người không có trong map nằm cùng nhóm offline.
    expect(result.offline.map((m) => m.displayName)).toEqual(["Bình", "Dũng"]);
  });

  it("người chọn Ẩn (status offline) nằm ở nhóm ngoại tuyến", () => {
    const result = partitionByPresence([member("4", "Bình")], presence);
    expect(result.offline).toHaveLength(1);
  });

  it("chưa có dữ liệu presence → tất cả offline", () => {
    const result = partitionByPresence([member("1", "An")], undefined);
    expect(result.online).toHaveLength(0);
    expect(result.offline).toHaveLength(1);
  });
});

describe("sortByPresence", () => {
  it("online → chờ → không làm phiền → offline, cùng nhóm thì theo tên", () => {
    const people = [
      member("4", "Bình"),
      member("3", "An"),
      member("2", "Cường"),
      member("1", "Dũng"),
      member("999", "Em"),
    ];
    expect(sortByPresence(people, presence).map((m) => m.displayName)).toEqual([
      "Dũng",
      "Cường",
      "An",
      "Bình",
      "Em",
    ]);
  });
});

describe("PRESENCE_DOT", () => {
  it("bốn trạng thái có bốn màu khác nhau", () => {
    const colors = Object.values(PRESENCE_DOT);
    expect(new Set(colors).size).toBe(4);
  });
});
