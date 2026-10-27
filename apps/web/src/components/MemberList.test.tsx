// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemberList, type MemberListProps } from "./MemberList.js";
import { useLocale } from "../lib/i18n.js";
import type { GuildMemberSummary, PresenceStatus, Role, Snowflake } from "@umaru/protocol";

/**
 * Danh sách thành viên — thứ trước đây app **hoàn toàn không có**. Test này khoá
 * phần nhìn thấy được: nhóm theo role, màu role, chấm trạng thái, vương miện cho
 * chủ server, nhãn "bạn", và nhóm **Ngoại tuyến** tách riêng như Discord.
 */

afterEach(cleanup);
beforeEach(() => useLocale.setState({ locale: "vi" }));

const sid = (value: string): Snowflake => value as Snowflake;

function role(id: string, name: string, position: number, color = 0): Role {
  return {
    id: sid(id),
    guildId: sid("g"),
    name,
    color,
    position,
    permissions: "0",
    isEveryone: false,
  };
}

function member(id: string, displayName: string, roleIds: string[] = []): GuildMemberSummary {
  return {
    userId: sid(id),
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    roleIds: roleIds.map(sid),
  } as GuildMemberSummary;
}

const everyone: Role = { ...role("r0", "@everyone", 0), isEveryone: true };
const adminRole = role("r1", "Quản trị", 9, 0x5865f2);

const online: Record<string, PresenceStatus> = { u1: "online", u3: "online" };

function setup(overrides: Partial<MemberListProps> = {}) {
  return render(
    <MemberList
      members={[member("u1", "Demo", ["r1"]), member("u2", "Minh"), member("u3", "Linh", ["r1"])]}
      roles={[everyone, adminRole]}
      presence={online}
      ownerId="u1"
      meId="u3"
      defaultSectionLabel="Thành viên"
      countLabel={(count) => `Thành viên — ${count}`}
      offlineLabel="Ngoại tuyến"
      youLabel="bạn"
      ownerLabel="Chủ server"
      {...overrides}
    />,
  );
}

describe("MemberList", () => {
  it("hiện tổng số thành viên ở đầu danh sách", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Thành viên — 3" })).toBeTruthy();
  });

  it("nhóm người online theo role, nhóm quyền cao trước", () => {
    setup();
    const headings = screen.getAllByRole("heading").map((node) => node.textContent);
    expect(headings).toEqual([
      "Thành viên — 3",
      "Quản trị — 2",
      "Ngoại tuyến — 1",
    ]);
  });

  it("người không có trong map presence nằm ở nhóm Ngoại tuyến", () => {
    setup();
    const list = screen.getByRole("complementary");
    const offlineSection = within(list).getByText("Ngoại tuyến — 1").closest("section");
    expect(offlineSection).not.toBeNull();
    expect(within(offlineSection as HTMLElement).getByText("Minh")).toBeTruthy();
  });

  it("tô tên theo màu role (người online) và làm mờ người ngoại tuyến", () => {
    setup();
    const style = screen.getByText("Demo").getAttribute("style") ?? "";
    // jsdom chuẩn hoá hex sang rgb — so cả hai dạng để test không phụ thuộc engine.
    expect(style).toMatch(/#5865f2|rgb\(88, 101, 242\)/);
    expect(screen.getByText("Minh").getAttribute("style")).toBeNull();
  });

  it("đánh dấu chủ server và chính mình", () => {
    setup();
    expect(screen.getByLabelText("Chủ server")).toBeTruthy();
    expect(screen.getByText("bạn")).toBeTruthy();
  });

  it("chấm trạng thái dùng màu theo status (idle khác online)", () => {
    setup({ presence: { u1: "idle", u3: "dnd" } });
    const dots = screen
      .getByRole("complementary")
      .querySelectorAll("span.absolute.-bottom-0\\.5");
    const classes = [...dots].map((node) => node.className);
    expect(classes.some((value) => value.includes("bg-amber-400"))).toBe(true);
    expect(classes.some((value) => value.includes("bg-rose-500"))).toBe(true);
  });

  it("tất cả ngoại tuyến → chỉ có nhóm Ngoại tuyến", () => {
    setup({ presence: {}, members: [member("u1", "Demo"), member("u2", "Minh")], ownerId: "u1" });
    const headings = screen.getAllByRole("heading").map((node) => node.textContent);
    expect(headings).toEqual(["Thành viên — 2", "Ngoại tuyến — 2"]);
  });

  it("danh sách rỗng vẫn hiện khung và số 0", () => {
    setup({ members: [] });
    expect(screen.getByRole("heading", { name: "Thành viên — 0" })).toBeTruthy();
    const list = screen.getByRole("complementary");
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
  });
});
