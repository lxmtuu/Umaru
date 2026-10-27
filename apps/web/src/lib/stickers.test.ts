import { describe, expect, it } from "vitest";
import { Permission } from "@umaru/protocol";
import {
  MAX_STICKER_BYTES,
  canManageStickers,
  defaultStickerName,
  validateSticker,
} from "./stickers.js";

/**
 * Phần thuần của sticker.
 *
 * Trọng tâm: kiểm tra ở client chỉ để báo lỗi **sớm** (server vẫn kiểm magic
 * bytes và tỉ lệ vuông), nên nó phải chặn đúng những gì server chặn — chặn
 * thiếu thì người dùng chờ upload xong mới thấy lỗi.
 */

function fileOf(name: string, type: string, size = 1024): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe("validateSticker", () => {
  it("nhận PNG/GIF/WebP/AVIF/APNG", () => {
    for (const type of ["image/png", "image/apng", "image/gif", "image/webp", "image/avif"]) {
      expect(validateSticker(fileOf("a", type))).toBeNull();
    }
  });

  it("bỏ qua tham số trong MIME", () => {
    expect(validateSticker(fileOf("a", "image/png; charset=binary"))).toBeNull();
  });

  it("chặn SVG và JPEG (server không nhận)", () => {
    expect(validateSticker(fileOf("a.svg", "image/svg+xml"))).toBe("stickerTypeBlocked");
    expect(validateSticker(fileOf("a.jpg", "image/jpeg"))).toBe("stickerTypeBlocked");
  });

  it("chặn tệp rỗng và tệp quá lớn", () => {
    expect(validateSticker(fileOf("a.png", "image/png", 0))).toBe("stickerFileEmpty");
    expect(validateSticker(fileOf("a.png", "image/png", MAX_STICKER_BYTES + 1))).toBe(
      "stickerTooLarge",
    );
    expect(validateSticker(fileOf("a.png", "image/png", MAX_STICKER_BYTES))).toBeNull();
  });
});

describe("canManageStickers", () => {
  it("cần MANAGE_EXPRESSIONS hoặc ADMINISTRATOR", () => {
    expect(canManageStickers(0n)).toBe(false);
    expect(canManageStickers(Permission.MANAGE_EXPRESSIONS)).toBe(true);
    expect(canManageStickers(Permission.ADMINISTRATOR)).toBe(true);
    expect(canManageStickers(Permission.MANAGE_EXPRESSIONS | Permission.SEND_MESSAGES)).toBe(true);
  });

  it("quyền khác không mở khoá", () => {
    expect(
      canManageStickers(Permission.MANAGE_CHANNELS | Permission.MANAGE_MESSAGES),
    ).toBe(false);
  });

  it("null (chưa tải quyền) = không cho", () => {
    expect(canManageStickers(null)).toBe(false);
  });

  it("MANAGE_EXPRESSIONS là bit mới, không đè bit cũ", () => {
    // Hồi quy: thêm bit mới mà trùng bit cũ thì quyền sửa kênh tự dưng cho xoá sticker.
    const used = new Set(Object.values(Permission).map((flag) => flag.toString()));
    expect(used.size).toBe(Object.values(Permission).length);
  });
});

describe("defaultStickerName", () => {
  it("bỏ đuôi, thay _ và - bằng khoảng trắng", () => {
    expect(defaultStickerName("meo_cuoi-2.png")).toBe("meo cuoi 2");
  });

  it("cắt 40 ký tự", () => {
    expect([...defaultStickerName(`${"a".repeat(60)}.png`)].length).toBe(40);
  });

  it("tên rỗng vẫn có giá trị dùng được", () => {
    expect(defaultStickerName(".png")).toBe("sticker");
    expect(defaultStickerName("   .png")).toBe("sticker");
  });
});
