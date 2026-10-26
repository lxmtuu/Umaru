import { describe, expect, it } from "vitest";
import { groupMembersByRole, topRole } from "./memberList.js";
import type { GuildMemberSummary, Role, Snowflake } from "@umaru/protocol";

/** Test không cần id hợp lệ theo format, chỉ cần đúng kiểu branded. */
const sid = (value: string): Snowflake => value as Snowflake;

function role({
  id,
  name,
  ...rest
}: Omit<Partial<Role>, "id" | "name"> & { id: string; name: string }): Role {
  return {
    guildId: sid("g"),
    color: 0,
    position: 0,
    permissions: "0",
    isEveryone: false,
    ...rest,
    id: sid(id),
    name,
  };
}

function member(id: string, displayName: string, roleIds: string[]): GuildMemberSummary {
  return {
    userId: sid(id),
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    roleIds: roleIds.map(sid),
  } as GuildMemberSummary;
}

const everyone = role({ id: "r0", name: "@everyone", isEveryone: true, position: 0 });
const mod = role({ id: "r2", name: "Điều hành", color: 0xeb459e, position: 5 });
const admin = role({ id: "r1", name: "Quản trị", color: 0x5865f2, position: 9 });

describe("groupMembersByRole", () => {
  it("nhóm theo role cao nhất, nhóm quyền cao đứng trước", () => {
    const sections = groupMembersByRole({
      members: [
        member("1", "Bình", ["r0"]),
        member("2", "An", ["r0", "r2"]),
        member("3", "Cường", ["r0", "r1"]),
      ],
      roles: [everyone, mod, admin],
      defaultSectionLabel: "Thành viên",
    });

    expect(sections.map((section) => section.name)).toEqual(["Quản trị", "Điều hành", "Thành viên"]);
    expect(sections[0]?.members.map((m) => m.displayName)).toEqual(["Cường"]);
    expect(sections[2]?.members.map((m) => m.displayName)).toEqual(["Bình"]);
  });

  it("người mang nhiều role chỉ nằm ở nhóm cao nhất (không trùng)", () => {
    const sections = groupMembersByRole({
      members: [member("1", "An", ["r0", "r2", "r1"])],
      roles: [everyone, mod, admin],
      defaultSectionLabel: "Thành viên",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe("Quản trị");
  });

  it("trong một nhóm sắp theo tên, không phân biệt hoa thường", () => {
    const sections = groupMembersByRole({
      members: [member("1", "bình", ["r2"]), member("2", "An", ["r2"]), member("3", "Cường", ["r2"])],
      roles: [everyone, mod],
      defaultSectionLabel: "Thành viên",
    });
    expect(sections[0]?.members.map((m) => m.displayName)).toEqual(["An", "bình", "Cường"]);
  });

  it("màu 0 coi là không có màu, không phải màu đen", () => {
    const noColor = role({ id: "r3", name: "Khách", color: 0, position: 1 });
    const sections = groupMembersByRole({
      members: [member("1", "An", ["r3"])],
      roles: [everyone, noColor],
      defaultSectionLabel: "Thành viên",
    });
    expect(sections[0]?.color).toBeNull();
  });

  it("role đã bị xoá khỏi server thì bỏ qua, không tạo nhóm ma", () => {
    const sections = groupMembersByRole({
      members: [member("1", "An", ["deleted-role"])],
      roles: [everyone],
      defaultSectionLabel: "Thành viên",
    });
    expect(sections.map((s) => s.name)).toEqual(["Thành viên"]);
  });

  it("server chỉ có @everyone → một nhóm mặc định", () => {
    const sections = groupMembersByRole({
      members: [member("1", "An", []), member("2", "Bình", ["r0"])],
      roles: [everyone],
      defaultSectionLabel: "Thành viên",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.members).toHaveLength(2);
  });

  it("danh sách rỗng → không có nhóm nào", () => {
    expect(
      groupMembersByRole({ members: [], roles: [everyone], defaultSectionLabel: "Thành viên" }),
    ).toEqual([]);
  });
});

describe("topRole", () => {
  it("bỏ qua @everyone dù người đó có mang", () => {
    const map = new Map([
      ["r0", everyone],
      ["r1", admin],
    ]);
    expect(topRole(member("1", "An", ["r0"]), map)).toBeNull();
    expect(topRole(member("1", "An", ["r0", "r1"]), map)?.id).toBe("r1");
  });
});
