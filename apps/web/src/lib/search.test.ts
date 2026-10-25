import { describe, expect, it } from "vitest";
import {
  normalizeSnippetText,
  resultText,
  snippetAround,
  splitHighlight,
} from "./search.js";

describe("normalizeSnippetText", () => {
  it("gộp xuống dòng và khoảng trắng thừa", () => {
    expect(normalizeSnippetText("  a\nb\t\tc  ")).toBe("a b c");
  });
});

describe("snippetAround", () => {
  it("giữ nguyên chuỗi ngắn", () => {
    expect(snippetAround("tin ngắn", "ngắn")).toBe("tin ngắn");
  });

  it("cắt quanh từ khoá và thêm dấu … hai đầu", () => {
    const text = `${"a".repeat(200)} kim cương ${"b".repeat(200)}`;
    const snippet = snippetAround(text, "kim cương", 60);
    expect(snippet.length).toBeLessThanOrEqual(62);
    expect(snippet).toContain("kim cương");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("không thêm … khi từ khoá ở đầu chuỗi", () => {
    const text = `kim cương ${"b".repeat(200)}`;
    const snippet = snippetAround(text, "kim cương", 60);
    expect(snippet.startsWith("…")).toBe(false);
    expect(snippet.startsWith("kim cương")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("không tìm thấy từ khoá vẫn cắt phần đầu, không ném lỗi", () => {
    const snippet = snippetAround("x".repeat(100), "không có", 20);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(21);
  });
});

describe("splitHighlight", () => {
  it("tách mọi lần xuất hiện, không phân biệt hoa/thường", () => {
    expect(splitHighlight("Xin chào, chào bạn", "CHÀO")).toEqual([
      { text: "Xin ", match: false },
      { text: "chào", match: true },
      { text: ", ", match: false },
      { text: "chào", match: true },
      { text: " bạn", match: false },
    ]);
  });

  it("không khớp → một đoạn bình thường", () => {
    expect(splitHighlight("abc", "zzz")).toEqual([{ text: "abc", match: false }]);
  });

  it("query rỗng hoặc toàn khoảng trắng → không tô sáng", () => {
    expect(splitHighlight("abc", "")).toEqual([{ text: "abc", match: false }]);
    expect(splitHighlight("abc", "   ")).toEqual([{ text: "abc", match: false }]);
  });

  it("ký tự đặc biệt của regex không được hiểu là mẫu", () => {
    expect(splitHighlight("giá (100) [gồm] a+b", "(100)")).toEqual([
      { text: "giá ", match: false },
      { text: "(100)", match: true },
      { text: " [gồm] a+b", match: false },
    ]);
  });

  it("chuỗi rỗng → mảng rỗng để render không lỗi", () => {
    expect(splitHighlight("", "a")).toEqual([]);
  });
});

describe("resultText", () => {
  it("ưu tiên nội dung tin", () => {
    expect(resultText("có chữ", 2, "[tệp]")).toBe("có chữ");
  });

  it("tin chỉ có tệp → nhãn", () => {
    expect(resultText("   ", 1, "[tệp đính kèm]")).toBe("[tệp đính kèm]");
  });

  it("tin rỗng hoàn toàn → chuỗi rỗng", () => {
    expect(resultText("", 0, "[tệp đính kèm]")).toBe("");
  });
});
