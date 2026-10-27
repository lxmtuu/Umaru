import { isIP } from "node:net";

/**
 * Phần "không cần mạng" của embed: tìm URL trong nội dung, chặn địa chỉ nội bộ,
 * và đọc thẻ meta từ HTML. Tách khỏi phần tải trang để test được bằng chuỗi.
 */

/** URL đầu tiên trong nội dung tin, hoặc null. */
export function firstUrl(content: string): string | null {
  // URL trong code (`...`) và code block (```...```) là **văn bản**, không phải
  // liên kết — Discord cũng không tạo embed cho chúng. Bỏ trước khi tìm.
  const prose = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const match = /https?:\/\/[^\s<>"']+/i.exec(prose);
  if (match === null) return null;
  // Dấu câu ở cuối câu ("xem https://a.com/vn.") không thuộc URL. Cắt cân bằng
  // ngoặc vì nhiều URL thật kết thúc bằng ")".
  let raw = match[0].replace(/[.,;:!?]+$/u, "");
  const opens = (raw.match(/\(/g) ?? []).length;
  const closes = (raw.match(/\)/g) ?? []).length;
  let extraCloses = closes - opens;
  while (extraCloses > 0 && raw.endsWith(")")) {
    raw = raw.slice(0, -1);
    extraCloses -= 1;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname === "") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Địa chỉ IP có thuộc vùng **không được** cho server gọi ra không.
 *
 * Đây là hàng rào SSRF: nội dung tin nhắn do người dùng nhập, nên nếu server tải
 * `http://127.0.0.1:5432` hay `http://169.254.169.254/latest/meta-data` thì kẻ
 * tấn công dùng chính server làm proxy vào mạng nội bộ/cloud metadata.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  // Không phải IP (vd tên miền còn chưa resolve) → coi như chặn.
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT — VPS thường nằm trong dải này
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
    (a === 198 && (b === 18 || b === 19)) || // benchmark
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast + reserved + broadcast
  );
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0] ?? "";
  // IPv4 ánh xạ trong IPv6 (`::ffff:127.0.0.1`) — kiểm theo dải IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped !== null) return isBlockedIpv4(mapped[1] as string);
  if (lower === "::" || lower === "::1") return true;
  const first = lower.split(":")[0] ?? "";
  const head = Number.parseInt(first === "" ? "0" : first, 16);
  if (Number.isNaN(head)) return true;
  return (
    (head & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (head & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (head & 0xff00) === 0xff00 || // multicast
    // 2001:db8::/32 — dải tài liệu, không nên có ai gọi ra thật.
    (head === 0x2001 && (Number.parseInt(lower.split(":")[1] ?? "0", 16) === 0x0db8))
  );
}

export interface ParsedEmbed {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

/** Chuẩn hoá text từ meta: gộp khoảng trắng, giải entity, cắt theo trần. */
function cleanText(value: string | null | undefined, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeEntities(value).replace(/\s+/gu, " ").trim();
  if (decoded === "") return null;
  return decoded.length > maxChars ? `${decoded.slice(0, maxChars - 1).trimEnd()}…` : decoded;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Mọi thẻ `<meta>` của trang, dạng `{ property|name : content }` (khoá lowercase). */
function readMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    const content = /content\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1];
    if (key === undefined || content === undefined) continue;
    const normalized = key.trim().toLowerCase();
    // Thẻ đầu tiên thắng: nhiều trang lặp `og:title` cho từng phần.
    if (!tags.has(normalized)) tags.set(normalized, content);
  }
  return tags;
}

/**
 * Đọc HTML thành embed. `null` khi trang không có gì đáng hiển thị (không tiêu
 * đề, không mô tả, không ảnh) — thà không có thẻ còn hơn thẻ trống.
 */
export function parseEmbedHtml(html: string, url: string): ParsedEmbed | null {
  const tags = readMetaTags(html);
  const pageTitle = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  const title =
    cleanText(tags.get("og:title"), 200) ??
    cleanText(tags.get("twitter:title"), 200) ??
    cleanText(pageTitle, 200);
  const description =
    cleanText(tags.get("og:description"), 400) ??
    cleanText(tags.get("twitter:description"), 400) ??
    cleanText(tags.get("description"), 400);
  const siteName =
    cleanText(tags.get("og:site_name"), 80) ?? cleanText(new URL(url).hostname, 80);
  const imageRaw = tags.get("og:image") ?? tags.get("twitter:image") ?? tags.get("og:image:url");
  const imageUrl = imageRaw === undefined ? null : absoluteImageUrl(imageRaw, url);

  if (title === null && description === null && imageUrl === null) return null;
  return { url, title, description, siteName, imageUrl };
}

/** `og:image` hay là đường dẫn tương đối; client cần URL tuyệt đối để tải ảnh. */
function absoluteImageUrl(raw: string, pageUrl: string): string | null {
  try {
    const resolved = new URL(raw.trim(), pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}
