import { describe, expect, it } from "vitest";
import { legalPath, readLegalLocale, readLegalRoute } from "./legalRoute.js";
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCS, LEGAL_UPDATED, LEGAL_OPERATOR } from "./legal.js";

describe("readLegalRoute", () => {
  it("nhận /terms và /privacy, kể cả có dấu / cuối hoặc chữ hoa", () => {
    expect(readLegalRoute("/terms")).toBe("terms");
    expect(readLegalRoute("/terms/")).toBe("terms");
    expect(readLegalRoute("/Terms")).toBe("terms");
    expect(readLegalRoute("/privacy")).toBe("privacy");
    expect(readLegalRoute("/privacy//")).toBe("privacy");
  });

  it("đường dẫn khác → null (rơi về app bình thường)", () => {
    expect(readLegalRoute("/")).toBeNull();
    expect(readLegalRoute("/terms/extra")).toBeNull();
    expect(readLegalRoute("")).toBeNull();
  });
});

describe("readLegalLocale", () => {
  it("đọc ?lang=, sai thì dùng ngôn ngữ đang chọn", () => {
    expect(readLegalLocale("?lang=en", "vi")).toBe("en");
    expect(readLegalLocale("?lang=vi", "en")).toBe("vi");
    expect(readLegalLocale("?lang=fr", "vi")).toBe("vi");
    expect(readLegalLocale("", "en")).toBe("en");
  });
});

describe("legalPath", () => {
  it("giữ ngôn ngữ trên URL", () => {
    expect(legalPath("terms", "vi")).toBe("/terms?lang=vi");
    expect(legalPath("privacy", "en")).toBe("/privacy?lang=en");
  });
});

describe("nội dung văn bản pháp lý", () => {
  const docs = [LEGAL_DOCS.terms, LEGAL_DOCS.privacy];

  it("có đủ EN và VI, cùng ngày hiệu lực với LEGAL_VERSION", () => {
    for (const doc of docs) {
      for (const locale of ["vi", "en"] as const) {
        expect(doc[locale].title.length).toBeGreaterThan(3);
        expect(doc[locale].updated).toBe(LEGAL_UPDATED);
        expect(doc[locale].sections.length).toBeGreaterThanOrEqual(9);
      }
    }
  });

  it("bản dịch có cùng số mục (không bỏ sót khi cập nhật)", () => {
    for (const doc of docs) {
      expect(doc.vi.sections.length).toBe(doc.en.sections.length);
    }
  });

  it("mọi mục đều có tiêu đề và nội dung, không mục rỗng", () => {
    for (const doc of docs) {
      for (const locale of ["vi", "en"] as const) {
        for (const section of doc[locale].sections) {
          expect(section.heading.trim().length).toBeGreaterThan(0);
          expect(section.paragraphs.length + (section.bullets?.length ?? 0)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("có tên người vận hành và email liên hệ thật", () => {
    expect(LEGAL_CONTACT_EMAIL).toContain("@");
    expect(LEGAL_OPERATOR.length).toBeGreaterThan(0);
    const contactVi = LEGAL_DOCS.privacy.vi.sections.at(-1)!;
    expect(contactVi.paragraphs.join(" ")).toContain(LEGAL_CONTACT_EMAIL);
  });
});
