/**
 * Tiện ích hiển thị kết quả tìm kiếm: cắt đoạn ngắn quanh từ khoá và tách
 * đoạn khớp để tô sáng.
 *
 * Không dùng regex trên chuỗi người dùng (tránh lỗi ký tự đặc biệt và backtracking):
 * so khớp bằng `indexOf` trên bản lowercase — độ dài giữ nguyên với tiếng Việt
 * (mỗi chữ có dấu là một code point) và tiếng Anh.
 */

export interface SearchSegment {
  text: string;
  match: boolean;
}

/** Bỏ xuống dòng/khoảng trắng thừa để một dòng kết quả không bị vỡ layout. */
export function normalizeSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Cắt đoạn quanh vị trí khớp đầu tiên.
 *
 * Trả về chuỗi đã chuẩn hoá khoảng trắng, có "…" ở đầu/cuối nếu bị cắt, sao cho
 * từ khoá luôn nằm trong đoạn nhìn thấy được.
 */
export function snippetAround(text: string, query: string, maxLength = 140): string {
  const flat = normalizeSnippetText(text);
  if (flat.length <= maxLength) return flat;

  const index = flat.toLowerCase().indexOf(query.trim().toLowerCase());
  if (index === -1) return `${flat.slice(0, maxLength).trimEnd()}…`;

  // Chừa chỗ cho dấu "…" hai đầu, đặt từ khoá ở khoảng 1/3 đoạn.
  const budget = Math.max(20, maxLength - 2);
  let start = Math.max(0, index - Math.floor(budget / 3));
  let end = Math.min(flat.length, start + budget);
  start = Math.max(0, Math.min(start, end - budget));

  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end).trim()}${tail}`;
}

/**
 * Tách chuỗi thành các đoạn khớp/không khớp để render `<mark>`.
 * Không phân biệt hoa/thường; `query` rỗng → một đoạn bình thường.
 */
export function splitHighlight(text: string, query: string): SearchSegment[] {
  if (text.length === 0) return [];
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [{ text, match: false }];

  const haystack = text.toLowerCase();
  const segments: SearchSegment[] = [];
  let index = 0;

  while (index < text.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      segments.push({ text: text.slice(index), match: false });
      break;
    }
    if (found > index) segments.push({ text: text.slice(index, found), match: false });
    segments.push({ text: text.slice(found, found + needle.length), match: true });
    index = found + needle.length;
  }

  return segments;
}

/** Nội dung hiển thị cho một dòng kết quả: text, hoặc nhãn khi tin chỉ có tệp. */
export function resultText(content: string, attachmentCount: number, attachmentLabel: string): string {
  const flat = normalizeSnippetText(content);
  if (flat.length > 0) return flat;
  return attachmentCount > 0 ? attachmentLabel : "";
}
