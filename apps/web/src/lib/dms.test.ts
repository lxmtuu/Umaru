import type { DmChannelSummary, GuildMemberSummary } from "@umaru/protocol";
import { describe, expect, it } from "vitest";
import { dmAvatarUrl, dmInitial, dmMemberCount, dmPeer, dmTitle, isGroupDm } from "./dms.js";

function member(
  id: string,
  displayName: string,
  avatarUrl: string | null = null,
): GuildMemberSummary {
  return {
    userId: id,
    username: `u${id}`,
    displayName,
    avatarUrl,
    roleIds: [],
  } as unknown as GuildMemberSummary;
}

function dm(overrides: Partial<DmChannelSummary> = {}): DmChannelSummary {
  return {
    channel: {
      id: "10",
      guildId: null,
      type: "dm",
      name: null,
      topic: null,
      categoryId: null,
      position: 0,
    },
    recipient: member("2", "Bình"),
    recipients: [member("2", "Bình")],
    ownerId: null,
    name: null,
    ...overrides,
  } as unknown as DmChannelSummary;
}

function group(name: string | null, names: string[]): DmChannelSummary {
  return dm({
    channel: {
      id: "20",
      guildId: null,
      type: "group_dm",
      name,
      topic: null,
      categoryId: null,
      position: 0,
    } as never,
    recipient: null,
    recipients: names.map((displayName, index) => member(String(index + 3), displayName)),
    ownerId: "1" as never,
    name,
  });
}

describe("tiện ích hiển thị DM", () => {
  it("DM 1-1: tiêu đề là tên người kia, có avatar, không phải nhóm", () => {
    const one = dm({ recipient: member("2", "Bình", "/api/v1/users/2/avatar/9") });
    expect(isGroupDm(one)).toBe(false);
    expect(dmTitle(one)).toBe("Bình");
    expect(dmPeer(one)?.userId).toBe("2");
    expect(dmAvatarUrl(one)).toBe("/api/v1/users/2/avatar/9");
    expect(dmInitial(one)).toBe("B");
    expect(dmMemberCount(one)).toBe(2);
  });

  it("nhóm chưa đặt tên: ghép tên thành viên", () => {
    const g = group(null, ["An", "Bình", "Chi"]);
    expect(isGroupDm(g)).toBe(true);
    expect(dmTitle(g)).toBe("An, Bình, Chi");
    expect(dmPeer(g)).toBeNull();
    expect(dmAvatarUrl(g)).toBeNull();
    expect(dmInitial(g)).toBe("👥");
    expect(dmMemberCount(g)).toBe(4);
  });

  it("nhóm đông người: rút gọn sau 3 tên", () => {
    expect(dmTitle(group(null, ["An", "Bình", "Chi", "Dũng", "Em"]))).toBe("An, Bình, Chi +2");
  });

  it("nhóm có tên riêng thì dùng tên đó", () => {
    expect(dmTitle(group("Nhóm dự án", ["An", "Bình"]))).toBe("Nhóm dự án");
  });

  it("tên nhóm toàn khoảng trắng coi như chưa đặt", () => {
    expect(dmTitle(group("   ", ["An", "Bình"]))).toBe("An, Bình");
  });

  it("nhóm không có ai (dữ liệu bất thường) vẫn không vỡ", () => {
    expect(dmTitle(group(null, []))).toBe("—");
  });
});
