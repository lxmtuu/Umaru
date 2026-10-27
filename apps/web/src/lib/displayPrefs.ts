/**
 * Tuỳ chọn hiển thị theo **máy** (không phải theo tài khoản): mật độ tin.
 *
 * Vì sao lưu ở `localStorage` chứ không lên server: đây là thứ phụ thuộc thiết
 * bị — cùng một người, điện thoại thích gọn còn màn hình lớn thích thoáng. Đưa
 * lên server sẽ phải thêm API, migration và đồng bộ hai chiều chỉ để đổi một
 * class Tailwind.
 *
 * Hàm ở đây thuần để test được: localStorage hỏng/rác không được làm trắng app.
 */

export interface DisplaySettings {
  /**
   * Mật độ tin kiểu Discord "compact": ẩn ảnh đại diện, giờ nằm ở lề trái, tên
   * tác giả nằm cùng dòng với nội dung.
   */
  compact: boolean;
}

export const DISPLAY_SETTINGS_KEY = "umaru.display";

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { compact: false };

/** Đọc từ chuỗi JSON trong localStorage; rác/hỏng → mặc định. */
export function parseDisplaySettings(raw: string | null): DisplaySettings {
  if (raw === null) return DEFAULT_DISPLAY_SETTINGS;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return DEFAULT_DISPLAY_SETTINGS;
    const record = value as Record<string, unknown>;
    return { compact: record["compact"] === true };
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

/** Lấy từ storage của trình duyệt; không có storage (SSR, chế độ riêng tư) → mặc định. */
export function readDisplaySettings(): DisplaySettings {
  if (typeof localStorage === "undefined") return DEFAULT_DISPLAY_SETTINGS;
  try {
    return parseDisplaySettings(localStorage.getItem(DISPLAY_SETTINGS_KEY));
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

/** Ghi xuống storage; lỗi (quota, chặn storage) không được làm hỏng UI. */
export function saveDisplaySettings(settings: DisplaySettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Trình duyệt chặn storage: giữ cài đặt trong bộ nhớ cho phiên này.
  }
}
