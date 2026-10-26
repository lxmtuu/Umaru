import { describe, expect, it } from "vitest";
import {
  activeMention,
  applyMention,
  insertSnippet,
  rankMentionCandidates,
} from "./composer.js";

const members = [
  { userId: "1", username: "minh", displayName: "Minh" },
  { userId: "2", username: "minhtuan", displayName: "Tuấn" },
  { userId: "3", username: "an", displayName: "Minh Anh" },
  { userId: "4", username: "hoanganh", displayName: "Hoàng Anh" },
  { userId: "5", username: "linh", displayName: "Linh" },
];

describe("activeMention", () => {
  it("nhận `@` ở đầu chuỗi và sau khoảng trắng", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("@mi", 3)).toEqual({ start: 0, query: "mi" });
    expect(activeMention("chào @mi", 8)).toEqual({ start: 5, query: "mi" });
    expect(activeMention("dòng 1\n@an", 10)).toEqual({ start: 7, query: "an" });
  });

  it("không nhận khi `@` dính sau chữ khác (email, đường dẫn)", () => {
    // `a@b` là email — bật popup giữa lúc gõ email là trải nghiệm rất tệ.
    expect(activeMention("a@b", 3)).toBeNull();
    expect(activeMention("xem https://x.dev/@minh", 22)).toBeNull();
  });

  it("không nhận query có ký tự ngoài username, hoặc quá dài", () => {
    expect(activeMention("@minh!", 6)).toBeNull();
    expect(activeMention("@có dấu", 8)).toBeNull();
    expect(activeMention(`@${"a".repeat(33)}`, 34)).toBeNull();
  });

  it("chỉ tính phần trước con trỏ: gõ tiếp sau mention cũ thì không còn gợi ý", () => {
    expect(activeMention("@minh xin chào", 15)).toBeNull();
    // Con trỏ ngay sau `@min` (giữa câu) vẫn phải nhận.
    expect(activeMention("@minh", 4)).toEqual({ start: 0, query: "min" });
  });

  it("`@` đứng sau khoảng trắng nhưng con trỏ ở trước nó → không nhận", () => {
    expect(activeMention("chào @minh", 3)).toBeNull();
  });
});

describe("rankMentionCandidates", () => {
  it("username khớp đầu đứng trước displayName khớp đầu, rồi tới khớp giữa", () => {
    const names = rankMentionCandidates(members, "minh").map((m) => m.username);
    // `minh`, `minhtuan` khớp **đầu username** → trước; `an` chỉ khớp giữa
    // displayName ("Minh Anh") nên xuống cuối. `hoanganh` không khớp gì → không có.
    expect(names).toEqual(["minh", "minhtuan", "an"]);
  });

  it("không phân biệt hoa thường và khớp cả displayName", () => {
    expect(rankMentionCandidates(members, "MINH").length).toBeGreaterThan(0);
    expect(rankMentionCandidates(members, "anh").map((m) => m.username)).toEqual([
      "an",
      "hoanganh",
    ]);
  });

  it("query rỗng trả danh sách đã sắp, cắt theo trần", () => {
    const all = rankMentionCandidates(members, "");
    expect(all).toHaveLength(5);
    expect(all[0]?.username).toBe("an");
    expect(rankMentionCandidates(members, "", 2)).toHaveLength(2);
  });

  it("không khớp ai thì trả rỗng (không bịa gợi ý)", () => {
    expect(rankMentionCandidates(members, "zzz")).toEqual([]);
  });
});

describe("insertSnippet / applyMention", () => {
  it("chèn giữa câu, giữ nguyên phần sau và trả con trỏ đúng", () => {
    expect(insertSnippet("abc def", 4, 4, "X")).toEqual({ text: "abc Xdef", caret: 5 });
    expect(insertSnippet("", 0, 0, "😊")).toEqual({ text: "😊", caret: 2 });
  });

  it("thay cả đoạn `@query` bằng `@username ` (có dấu cách cuối)", () => {
    const trigger = { start: 5, query: "mi" };
    const result = applyMention("chào @mi", trigger, 8, "minh");
    // Dấu cách cuối là bắt buộc: viết liền sau mention thì server đọc thành một
    // username khác và không báo ai.
    expect(result.text).toBe("chào @minh ");
    // Con trỏ nằm ngay sau dấu cách: "chào " (5) + "@minh " (6) = 11.
    expect(result.caret).toBe(11);
  });

  it("bỏ qua chỉ số con trỏ nằm ngoài chuỗi (không ném lỗi)", () => {
    expect(insertSnippet("abc", 99, 120, "X")).toEqual({ text: "abcX", caret: 4 });
    expect(insertSnippet("abc", -5, 1, "X")).toEqual({ text: "Xbc", caret: 1 });
  });
});
