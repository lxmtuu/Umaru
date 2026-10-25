import { describe, expect, it } from "vitest";
import {
  formatBytes,
  isImageAttachment,
  MAX_FILES_PER_MESSAGE,
  validateFiles,
} from "./attachments.js";
import type { Attachment } from "@umaru/protocol";

function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

const attachment = (mimeType: string): Attachment =>
  ({
    id: "1",
    filename: "x",
    url: "/api/v1/attachments/1",
    size: 10,
    mimeType,
    width: null,
    height: null,
  }) as Attachment;

describe("validateFiles", () => {
  it("nhận ảnh và tài liệu hợp lệ", () => {
    const result = validateFiles(
      [file("a.png", "image/png"), file("b.pdf", "application/pdf")],
      [],
    );
    expect(result.error).toBeNull();
    expect(result.accepted.map((item) => item.name)).toEqual(["a.png", "b.pdf"]);
  });

  it("chặn SVG và HTML (có thể chạy script)", () => {
    expect(validateFiles([file("x.svg", "image/svg+xml")], []).accepted).toEqual([]);
    expect(validateFiles([file("x.svg", "image/svg+xml")], []).error).toContain("x.svg");
    expect(validateFiles([file("x.html", "text/html")], []).error).toContain("x.html");
  });

  it("chặn tệp quá 10MB", () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    const result = validateFiles([big], []);
    expect(result.accepted).toEqual([]);
    expect(result.error).toContain("big.png");
  });

  it("cắt theo số lượng tối đa và báo lỗi", () => {
    const files = Array.from({ length: 6 }, (_, index) => file(`f${index}.png`, "image/png"));
    const result = validateFiles(files, []);
    expect(result.accepted).toHaveLength(MAX_FILES_PER_MESSAGE);
    expect(result.error).not.toBeNull();
  });

  it("giữ tệp đã chọn trước đó và bỏ tệp trùng", () => {
    const first = file("a.png", "image/png");
    const duplicate = file("a.png", "image/png");
    const result = validateFiles([duplicate, file("b.png", "image/png")], [first]);
    expect(result.accepted.map((item) => item.name)).toEqual(["a.png", "b.png"]);
  });
});

describe("tiện ích hiển thị", () => {
  it("formatBytes đổi đơn vị", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("nhận diện ảnh theo mime", () => {
    expect(isImageAttachment(attachment("image/png"))).toBe(true);
    expect(isImageAttachment(attachment("application/pdf"))).toBe(false);
  });
});
