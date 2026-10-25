import { describe, expect, it } from "vitest";
import {
  Permission,
  grantPermissions,
  hasPermission,
  parsePermissions,
  permissionNames,
  revokePermissions,
  serializePermissions,
} from "./permissions.js";

describe("permissions", () => {
  it("grant / revoke / has", () => {
    let bits = 0n;
    bits = grantPermissions(bits, Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES);
    expect(hasPermission(bits, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.BAN_MEMBERS)).toBe(false);

    bits = revokePermissions(bits, Permission.SEND_MESSAGES);
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(bits, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it("serialize / parse roundtrip (JSON-safe)", () => {
    const bits = Permission.VIEW_CHANNEL | Permission.MANAGE_ROLES | Permission.SPEAK;
    const raw = serializePermissions(bits);
    expect(raw).toMatch(/^\d+$/);
    expect(parsePermissions(raw)).toBe(bits);
  });

  it("permissionNames liệt kê đúng các bit đang bật", () => {
    const bits = Permission.VIEW_CHANNEL | Permission.READ_HISTORY;
    expect(permissionNames(bits).sort()).toEqual(["READ_HISTORY", "VIEW_CHANNEL"]);
    expect(permissionNames(0n)).toEqual([]);
  });

  it("ADMINISTRATOR là bit riêng, phân biệt được với quyền thường", () => {
    const admin = Permission.ADMINISTRATOR;
    expect(admin).toBe(1n << 11n);
    expect(permissionNames(admin)).toEqual(["ADMINISTRATOR"]);
    expect(hasPermission(admin, Permission.BAN_MEMBERS)).toBe(false); // không tự "hiện" quyền thường
  });

  it("parse bitfield rác ném TypeError", () => {
    expect(() => parsePermissions("0x10")).toThrow(TypeError);
    expect(() => parsePermissions("")).toThrow(TypeError);
    expect(() => parsePermissions("-5")).toThrow(TypeError);
  });
});
