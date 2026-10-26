import { describe, expect, it } from "vitest";
import {
  findRoleMentions,
  parseInline,
  parseMessage,
  type BlockNode,
  type InlineNode,
} from "./markdown.js";

/** Chuyển cây node về dạng dễ so sánh trong test. */
function serialize(nodes: InlineNode[]): unknown[] {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return { code: node.value };
      case "link":
        return { link: node.href };
      case "mention":
        return { mention: node.value, role: node.role === true };
      default:
        return { [node.type]: serialize(node.children) };
    }
  });
}

function blocksOf(content: string): unknown[] {
  return parseMessage(content).map((block: BlockNode) => {
    if (block.type === "codeBlock") return { codeBlock: block.value, language: block.language };
    return { [block.type]: serialize(block.children) };
  });
}

describe("parseInline", () => {
  it("để nguyên văn khi không có markdown", () => {
    expect(serialize(parseInline("Xin chào Umaru"))).toEqual(["Xin chào Umaru"]);
  });

  it("in đậm, nghiêng, gạch chân, gạch ngang", () => {
    expect(serialize(parseInline("**đậm**"))).toEqual([{ strong: ["đậm"] }]);
    expect(serialize(parseInline("*nghiêng*"))).toEqual([{ emphasis: ["nghiêng"] }]);
    expect(serialize(parseInline("__chân__"))).toEqual([{ underline: ["chân"] }]);
    expect(serialize(parseInline("~~ngang~~"))).toEqual([{ strike: ["ngang"] }]);
  });

  it("***x*** là đậm + nghiêng", () => {
    expect(serialize(parseInline("***cả hai***"))).toEqual([{ strong: [{ emphasis: ["cả hai"] }] }]);
  });

  it("`code` là nguyên văn, không parse markdown bên trong", () => {
    expect(serialize(parseInline("dùng `**không đậm**` nhé"))).toEqual([
      "dùng ",
      { code: "**không đậm**" },
      " nhé",
    ]);
  });

  it("**_lồng nhau_** hoạt động", () => {
    expect(serialize(parseInline("**đậm _nghiêng_ đậm**"))).toEqual([
      { strong: ["đậm ", { emphasis: ["nghiêng"] }, " đậm"] },
    ]);
  });

  it("snake_case không bị biến thành in nghiêng", () => {
    expect(serialize(parseInline("biến snake_case_name nhé"))).toEqual(["biến snake_case_name nhé"]);
    // `_x_` đứng riêng vẫn là in nghiêng.
    expect(serialize(parseInline("dùng _x_ đi"))).toEqual(["dùng ", { emphasis: ["x"] }, " đi"]);
  });

  it("dấu chưa đóng được giữ nguyên văn", () => {
    expect(serialize(parseInline("**chưa đóng"))).toEqual(["**chưa đóng"]);
    expect(serialize(parseInline("một `backtick"))).toEqual(["một `backtick"]);
    expect(serialize(parseInline("** có khoảng trắng **"))).toEqual(["** có khoảng trắng **"]);
  });

  it("link tự động, dấu chấm cuối câu không nằm trong link", () => {
    expect(serialize(parseInline("xem https://umaru.dev/docs. nhé"))).toEqual([
      "xem ",
      { link: "https://umaru.dev/docs" },
      ". nhé",
    ]);
  });

  it("javascript: không thành link", () => {
    expect(serialize(parseInline("javascript:alert(1)"))).toEqual(["javascript:alert(1)"]);
  });

  it("highlight @mention theo đúng bộ ký tự username của backend", () => {
    expect(serialize(parseInline("@alice_smoke chào"))).toEqual([
      { mention: "@alice_smoke", role: false },
      " chào",
    ]);
    expect(serialize(parseInline("@a không phải mention"))).toEqual(["@a không phải mention"]);
    // Email không bị cắt thành mention.
    expect(serialize(parseInline("gửi a@example.com nhé"))).toEqual(["gửi a@example.com nhé"]);
  });
});

describe("parseMessage", () => {
  it("tách đoạn theo dòng trống", () => {
    expect(blocksOf("dòng một\ndòng hai\n\nđoạn hai")).toEqual([
      { paragraph: ["dòng một\ndòng hai"] },
      { paragraph: ["đoạn hai"] },
    ]);
  });

  it("fence code block giữ nguyên xuống dòng và ngôn ngữ", () => {
    expect(blocksOf("```ts\nconst a = **1**;\n```")).toEqual([
      { codeBlock: "const a = **1**;", language: "ts" },
    ]);
  });

  it("fence chưa đóng lấy tới hết tin", () => {
    expect(blocksOf("```\nchưa đóng\nvẫn còn")).toEqual([
      { codeBlock: "chưa đóng\nvẫn còn", language: null },
    ]);
  });

  it("quote gộp các dòng liên tiếp", () => {
    expect(blocksOf("> trích dẫn\n> dòng hai\nsau đó")).toEqual([
      { quote: ["trích dẫn\ndòng hai"] },
      { paragraph: ["sau đó"] },
    ]);
  });

  it("markdown nằm trong quote và code block hoạt động độc lập", () => {
    expect(blocksOf("> **đậm** trong quote")).toEqual([{ quote: [{ strong: ["đậm"] }, " trong quote"] }]);
    expect(blocksOf("```\n**không đậm**\n```")).toEqual([
      { codeBlock: "**không đậm**", language: null },
    ]);
  });

  it("nội dung rỗng không tạo khối", () => {
    expect(blocksOf("")).toEqual([]);
    expect(blocksOf("   \n\n  ")).toEqual([]);
  });

  it("HTML thô hiện nguyên văn, không được diễn giải", () => {
    expect(blocksOf("<img src=x onerror=alert(1)>")).toEqual([
      { paragraph: ["<img src=x onerror=alert(1)>"] },
    ]);
  });
});

describe("nhắc role trong markdown", () => {
  it("khớp tên role có dấu và khoảng trắng, không cắt giữa từ", () => {
    const nodes = parseInline("@Đội QA xem giúp", 0, { roleNames: ["QA", "Đội QA"] });
    expect(serialize(nodes)).toEqual([
      { mention: "@Đội QA", role: true },
      " xem giúp",
    ]);
  });

  it("`@QAs` không khớp role `@QA` nhưng vẫn là mention username", () => {
    const nodes = parseInline("@QAs ơi", 0, { roleNames: ["QA"] });
    // Username chỉ nhận `@QAs` nếu đúng 2-32 ký tự — ở đây vẫn là mention thường.
    expect(serialize(nodes)).toEqual([{ mention: "@QAs", role: false }, " ơi"]);
  });

  it("`@everyone` trong tên role không bị nhân đôi dấu `@`", () => {
    const nodes = parseInline("@everyone họp nhé", 0, { roleNames: ["@everyone"] });
    expect(serialize(nodes)).toEqual([{ mention: "@everyone", role: true }, " họp nhé"]);
  });

  it("email `a@QA` không thành nhắc role", () => {
    expect(findRoleMentions("mail a@QA nhé", ["QA"])).toEqual([]);
  });

  it("findRoleMentions trả tên role theo thứ tự xuất hiện", () => {
    expect(findRoleMentions("@QA và @Đội QA", ["QA", "Đội QA"])).toEqual(["QA", "Đội QA"]);
  });

  it("không có roleNames thì không có node role nào", () => {
    const nodes = parseInline("@Đội QA xem", 0);
    expect(nodes.some((node) => node.type === "mention" && node.role === true)).toBe(false);
  });
});
