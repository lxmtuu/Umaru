import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  Permission,
  grantPermissions,
  hasPermission,
  resolvePermissions,
  type ResolvePermissionsInput,
} from "./permissions.js";
import type { Snowflake } from "./snowflake.js";

const id = (value: string) => value as Snowflake;

const everyoneRoleId = id("1");
const roleMod = id("2");
const roleHelper = id("3");
const userId = id("10");
const otherUserId = id("11");

const DEFAULT_EVERYONE = grantPermissions(
  0n,
  Permission.VIEW_CHANNEL,
  Permission.SEND_MESSAGES,
  Permission.READ_HISTORY,
);

function input(overrides: Partial<ResolvePermissionsInput> = {}): ResolvePermissionsInput {
  return {
    userId,
    isGuildOwner: false,
    everyoneRoleId,
    everyonePermissions: DEFAULT_EVERYONE,
    memberRoles: [],
    overwrites: [],
    ...overrides,
  };
}

describe("resolvePermissions", () => {
  it("owner có mọi quyền bất kể overwrite", () => {
    const bits = resolvePermissions(
      input({
        isGuildOwner: true,
        overwrites: [
          { targetType: "member", targetId: userId, allow: 0n, deny: ALL_PERMISSIONS },
        ],
      }),
    );
    expect(bits).toBe(ALL_PERMISSIONS);
  });

  it("ADMINISTRATOR từ role cho mọi quyền", () => {
    const bits = resolvePermissions(
      input({ memberRoles: [{ id: roleMod, permissions: Permission.ADMINISTRATOR }] }),
    );
    expect(bits).toBe(ALL_PERMISSIONS);
  });

  it("không có role vẫn có quyền của @everyone", () => {
    const bits = resolvePermissions(input());
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.MANAGE_CHANNELS)).toBe(false);
  });

  it("@everyone bị deny nhưng role allow thì được phép lại", () => {
    const bits = resolvePermissions(
      input({
        memberRoles: [{ id: roleMod, permissions: 0n }],
        overwrites: [
          { targetType: "role", targetId: everyoneRoleId, allow: 0n, deny: Permission.VIEW_CHANNEL },
          { targetType: "role", targetId: roleMod, allow: Permission.VIEW_CHANNEL, deny: 0n },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it("deny của một role thắng allow của role khác (union rồi trừ)", () => {
    const bits = resolvePermissions(
      input({
        memberRoles: [
          { id: roleMod, permissions: 0n },
          { id: roleHelper, permissions: 0n },
        ],
        overwrites: [
          { targetType: "role", targetId: roleMod, allow: Permission.MANAGE_MESSAGES, deny: 0n },
          { targetType: "role", targetId: roleHelper, allow: 0n, deny: Permission.MANAGE_MESSAGES },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.MANAGE_MESSAGES)).toBe(false);
  });

  it("overwrite của member đè lên deny của role", () => {
    const bits = resolvePermissions(
      input({
        memberRoles: [{ id: roleMod, permissions: 0n }],
        overwrites: [
          { targetType: "role", targetId: roleMod, allow: 0n, deny: Permission.SEND_MESSAGES },
          { targetType: "member", targetId: userId, allow: Permission.SEND_MESSAGES, deny: 0n },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
  });

  it("overwrite cho member khác không ảnh hưởng", () => {
    const bits = resolvePermissions(
      input({
        overwrites: [
          {
            targetType: "member",
            targetId: otherUserId,
            allow: Permission.MANAGE_CHANNELS,
            deny: 0n,
          },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.MANAGE_CHANNELS)).toBe(false);
  });

  it("bit không được định nghĩa bị loại khỏi kết quả", () => {
    const bits = resolvePermissions(input({ everyonePermissions: 1n << 40n }));
    expect(bits & (1n << 40n)).toBe(0n);
  });

  it("overwrite của category áp trước: deny ở category, allow riêng member ở kênh thắng", () => {
    const bits = resolvePermissions(
      input({
        inheritedOverwrites: [
          { targetType: "role", targetId: everyoneRoleId, allow: 0n, deny: Permission.VIEW_CHANNEL },
        ],
        overwrites: [
          { targetType: "member", targetId: userId, allow: Permission.VIEW_CHANNEL, deny: 0n },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it("overwrite của kênh cùng target thắng category", () => {
    const bits = resolvePermissions(
      input({
        inheritedOverwrites: [
          { targetType: "role", targetId: everyoneRoleId, allow: 0n, deny: Permission.SEND_MESSAGES },
        ],
        overwrites: [
          { targetType: "role", targetId: everyoneRoleId, allow: Permission.SEND_MESSAGES, deny: 0n },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
  });

  it("category chỉ deny mà kênh không đụng thì deny có hiệu lực", () => {
    const bits = resolvePermissions(
      input({
        inheritedOverwrites: [
          { targetType: "role", targetId: everyoneRoleId, allow: 0n, deny: Permission.READ_HISTORY },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.READ_HISTORY)).toBe(false);
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
  });

  it("không có overwrite thì quyền = union của everyone + member roles", () => {
    const bits = resolvePermissions(
      input({
        memberRoles: [
          { id: roleMod, permissions: grantPermissions(0n, Permission.MANAGE_MESSAGES) },
        ],
      }),
    );
    expect(hasPermission(bits, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.MANAGE_CHANNELS)).toBe(false);
  });
});
