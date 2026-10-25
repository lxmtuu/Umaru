import type { GuildMemberSummary } from "@umaru/protocol";
import { describe, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, validateAvatar } from "./avatars.js";
import { applyProfile } from "./chatStore.js";

function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("validateAvatar", () => {
  it("nhận các định dạng ảnh raster server hỗ trợ", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(validateAvatar(file("a", mime))).toBeNull();
    }
  });

  it("bỏ qua tham số trong MIME (image/png; charset=...)", () => {
    expect(validateAvatar(file("a", "image/png; charset=binary"))).toBeNull();
  });

  it("từ chối SVG — chứa được script, server cũng không nhận", () => {
    expect(validateAvatar(file("x.svg", "image/svg+xml"))).toBe("avatarTypeBlocked");
  });

  it("từ chối PDF và tệp rỗng", () => {
    expect(validateAvatar(file("a.pdf", "application/pdf"))).toBe("avatarTypeBlocked");
    expect(validateAvatar(file("empty.png", "image/png", 0))).toBe("avatarTypeBlocked");
  });

  it("từ chối ảnh quá 5MB", () => {
    const big = new File([new Uint8Array(8)], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: MAX_AVATAR_BYTES + 1 });
    expect(validateAvatar(big)).toBe("avatarTooLarge");
  });
});

describe("applyProfile", () => {
  const base = {
    me: {
      id: "1",
      username: "toi",
      displayName: "Tôi",
      avatarUrl: null,
      status: "online" as const,
      emailVerified: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    members: {
      "10": [
        { userId: "1", username: "toi", displayName: "Tôi", avatarUrl: null, roleIds: [] },
        { userId: "2", username: "ban", displayName: "Bạn", avatarUrl: null, roleIds: [] },
      ] as unknown as GuildMemberSummary[],
    },
    dms: [
      {
        channel: { id: "99" },
        recipient: { userId: "1", username: "toi", displayName: "Tôi", avatarUrl: null },
      },
    ],
  } as unknown as Parameters<typeof applyProfile>[0];

  it("cập nhật chính mình, thành viên và người trong DM", () => {
    const patch = applyProfile(base, {
      id: "1" as never,
      username: "toi",
      displayName: "Tôi",
      avatarUrl: "/api/v1/users/1/avatar/5",
    });

    expect(patch.me?.avatarUrl).toBe("/api/v1/users/1/avatar/5");
    expect(patch.members?.["10"]?.[0]?.avatarUrl).toBe("/api/v1/users/1/avatar/5");
    // Người khác không bị đổi.
    expect(patch.members?.["10"]?.[1]?.avatarUrl).toBeNull();
    expect(patch.dms?.[0]?.recipient.avatarUrl).toBe("/api/v1/users/1/avatar/5");
    // Presence không bị ghi đè bởi USER_UPDATE.
    expect(patch.me?.status).toBe("online");
  });

  it("applies gỡ avatar: avatarUrl về null ở mọi nơi", () => {
    const withAvatar = {
      ...base,
      me: { ...base.me!, avatarUrl: "/api/v1/users/1/avatar/5" },
    } as Parameters<typeof applyProfile>[0];
    const patch = applyProfile(withAvatar, {
      id: "1" as never,
      username: "toi",
      displayName: "Tôi",
      avatarUrl: null,
    });
    expect(patch.me?.avatarUrl).toBeNull();
    expect(patch.members?.["10"]?.[0]?.avatarUrl).toBeNull();
  });

  it("người lạ (không có trong bộ nhớ) không làm hỏng state", () => {
    const patch = applyProfile(base, {
      id: "404" as never,
      username: "la",
      displayName: "Lạ",
      avatarUrl: "/api/v1/users/404/avatar/1",
    });
    expect(patch.me).toBe(base.me);
    expect(patch.members?.["10"]).toHaveLength(2);
  });
});
