/**
 * Đọc kích thước ảnh từ header (không cần dependency, không giải mã pixel).
 *
 * Client dùng `width`/`height` để giữ đúng tỉ lệ khung trước khi ảnh tải xong
 * (tránh layout nhảy). Không nhận ra định dạng → `null`, vẫn hiển thị bình thường.
 */
export interface ImageSize {
  width: number;
  height: number;
}

/** Số byte đầu file đủ để đọc header của mọi định dạng đang hỗ trợ. */
export const HEADER_BYTES = 64 * 1024;

function fromPng(buffer: Buffer): ImageSize | null {
  if (buffer.length < 24) return null;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function fromGif(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;
  const signature = buffer.subarray(0, 6).toString("latin1");
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function fromJpeg(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    // SOF0…SOF15 mô tả khung ảnh, trừ DHT(C4)/JPG(C8)/DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function fromWebp(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buffer.subarray(8, 12).toString("latin1") !== "WEBP") return null;
  const chunk = buffer.subarray(12, 16).toString("latin1");

  if (chunk === "VP8 ") {
    // Khung keyframe: 0x9d 0x01 0x2a rồi 14 bit width, 14 bit height.
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const width = 1 + (buffer[24] ?? 0) + ((buffer[25] ?? 0) << 8) + ((buffer[26] ?? 0) << 16);
    const height = 1 + (buffer[27] ?? 0) + ((buffer[28] ?? 0) << 8) + ((buffer[29] ?? 0) << 16);
    return { width, height };
  }
  return null;
}

export function readImageSize(buffer: Buffer): ImageSize | null {
  const size = fromPng(buffer) ?? fromGif(buffer) ?? fromJpeg(buffer) ?? fromWebp(buffer);
  if (size === null) return null;
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return size;
}

export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}
