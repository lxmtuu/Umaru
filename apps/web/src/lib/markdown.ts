/**
 * Parser markdown tối giản theo tập Discord dùng cho nội dung tin nhắn.
 *
 * Vì sao tự viết thay vì `marked`/`remark`: nội dung tin nhắn là dữ liệu người
 * dùng, render bằng React element (không `dangerouslySetInnerHTML`) nên không
 * có đường nào bơm HTML vào DOM. Parser chỉ trả về cây node thuần dữ liệu:
 * test được bằng unit test, không cần DOM, và chỉ bundle ~2 KiB.
 *
 * Hỗ trợ: ```fence```, `code`, **đậm**, *nghiêng*, __gạch chân__,
 * ~~gạch ngang~~, > quote, link tự động http(s), @mention.
 * Không hỗ trợ (cố ý): HTML thô, ảnh nhúng, bảng — nội dung độc hại sẽ hiện
 * nguyên văn thay vì được diễn giải.
 */

export interface TextNode {
  type: "text";
  value: string;
}

export interface CodeNode {
  type: "code";
  value: string;
}

export interface LinkNode {
  type: "link";
  href: string;
  value: string;
}

export interface MentionNode {
  type: "mention";
  value: string;
}

export interface MarkNode {
  type: "strong" | "emphasis" | "underline" | "strike";
  children: InlineNode[];
}

export type InlineNode = TextNode | CodeNode | LinkNode | MentionNode | MarkNode;

export interface ParagraphBlock {
  type: "paragraph";
  children: InlineNode[];
}

export interface QuoteBlock {
  type: "quote";
  children: InlineNode[];
}

export interface CodeBlock {
  type: "codeBlock";
  language: string | null;
  value: string;
}

export type BlockNode = ParagraphBlock | QuoteBlock | CodeBlock;

/** Username giống backend (`services/api/src/mentions.ts`) để badge và highlight khớp nhau. */
const MENTION_PATTERN = /^@([a-z0-9._-]{2,32})/i;
const URL_PATTERN = /^https?:\/\/[^\s<>()[\]{}"']+/i;
const URL_TRAILING = /[.,;:!?]+$/;

/** Cặp dấu mở/đóng, xét theo thứ tự dài trước để `***` thắng `**`. */
const DELIMITERS: { token: string; marks: MarkNode["type"][] }[] = [
  { token: "***", marks: ["strong", "emphasis"] },
  { token: "**", marks: ["strong"] },
  { token: "__", marks: ["underline"] },
  { token: "~~", marks: ["strike"] },
  { token: "*", marks: ["emphasis"] },
  { token: "_", marks: ["emphasis"] },
];

const MAX_INLINE_DEPTH = 4;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Tìm vị trí đóng hợp lệ cho một cặp dấu.
 * `_` chỉ được tính khi không dính chữ ở hai đầu — `snake_case_name` trong
 * tin nhắn của dev phải hiện nguyên văn, không thành in nghiêng.
 */
function findClosing(input: string, from: number, token: string): number {
  let index = from;
  while (index < input.length) {
    const found = input.indexOf(token, index);
    if (found === -1) return -1;
    const inner = input.slice(from, found);
    // `from` nằm sau dấu mở → ký tự đứng trước dấu mở là `from - token.length - 1`.
    const before = input[from - token.length - 1];
    const after = input[found + token.length];
    const wordBoundaryOk =
      token !== "_" || (!isWordChar(before) && !isWordChar(after));
    if (inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner) && wordBoundaryOk) {
      return found;
    }
    index = found + 1;
  }
  return -1;
}

function wrap(marks: MarkNode["type"][], children: InlineNode[]): InlineNode {
  const last = marks[marks.length - 1];
  if (last === undefined) return { type: "text", value: "" };
  // `***x***` → strong bọc emphasis: dựng từ trong ra (`emphasis` trước).
  let node: InlineNode = { type: last, children };
  for (let index = marks.length - 2; index >= 0; index -= 1) {
    const mark = marks[index];
    if (mark !== undefined) node = { type: mark, children: [node] };
  }
  return node;
}

export function parseInline(input: string, depth = 0): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  let index = 0;

  const flushText = () => {
    if (text.length > 0) {
      nodes.push({ type: "text", value: text });
      text = "";
    }
  };

  while (index < input.length) {
    const rest = input.slice(index);

    // `code` — nội dung trong backtick là nguyên văn, không parse tiếp.
    if (rest[0] === "`") {
      const close = input.indexOf("`", index + 1);
      const value = close === -1 ? "" : input.slice(index + 1, close);
      if (close !== -1 && value.length > 0 && !/^\s|\s$/.test(value)) {
        flushText();
        nodes.push({ type: "code", value });
        index = close + 1;
        continue;
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      const delimiter = DELIMITERS.find((candidate) => rest.startsWith(candidate.token));
      if (delimiter !== undefined) {
        const from = index + delimiter.token.length;
        const close = findClosing(input, from, delimiter.token);
        if (close !== -1) {
          flushText();
          nodes.push(wrap(delimiter.marks, parseInline(input.slice(from, close), depth + 1)));
          index = close + delimiter.token.length;
          continue;
        }
        // Không có dấu đóng → giữ nguyên văn cả cụm (giống Discord).
        text += delimiter.token;
        index = from;
        continue;
      }
    }

    const mention = MENTION_PATTERN.exec(rest);
    // Email (`a@example.com`) không phải mention: ký tự trước `@` phải không
    // dính chữ/số và không phải `@`, `.`, `+`, `-`.
    const previous = index === 0 ? undefined : input[index - 1];
    const mentionAllowed =
      previous === undefined || (!isWordChar(previous) && !["@", ".", "+", "-"].includes(previous));
    if (mention !== null && mention[0].length > 0 && mentionAllowed) {
      flushText();
      nodes.push({ type: "mention", value: mention[0] });
      index += mention[0].length;
      continue;
    }

    const url = URL_PATTERN.exec(rest);
    if (url !== null && url[0].length > 0) {
      const raw = url[0];
      const cleaned = raw.replace(URL_TRAILING, "");
      flushText();
      nodes.push({ type: "link", href: cleaned, value: cleaned });
      // Dấu câu dính sau link (dấu chấm cuối câu) vẫn là text thường.
      text += raw.slice(cleaned.length);
      index += raw.length;
      continue;
    }

    text += rest[0] ?? "";
    index += 1;
  }

  flushText();
  return nodes;
}

/** Tách khối: fence code, quote, đoạn văn. */
export function parseMessage(content: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const value = paragraph.join("\n").trim();
    if (value.length > 0) blocks.push({ type: "paragraph", children: parseInline(value) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    // ```lang ... ``` — fence chưa đóng thì lấy tới hết tin (giống Discord).
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const language = line.trimStart().slice(3).trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({
        type: "codeBlock",
        language: language.length > 0 ? language : null,
        value: body.join("\n"),
      });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      const value = quoted.join("\n").trim();
      if (value.length > 0) blocks.push({ type: "quote", children: parseInline(value) });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}
