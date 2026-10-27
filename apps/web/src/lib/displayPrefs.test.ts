// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_SETTINGS,
  DISPLAY_SETTINGS_KEY,
  parseDisplaySettings,
  readDisplaySettings,
  saveDisplaySettings,
} from "./displayPrefs.js";

/**
 * Tuỳ chọn hiển thị đọc từ `localStorage` — tức là dữ liệu **người dùng (hoặc
 * extension khác) sửa được**. Rác trong đó không được làm trắng app, nên phần
 * `parse` là thứ đáng test nhất, không phải phần `JSON.stringify`.
 */

beforeEach(() => {
  localStorage.clear();
});

describe("parseDisplaySettings", () => {
  it("chưa có gì → mặc định (không thu gọn)", () => {
    expect(parseDisplaySettings(null)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(DEFAULT_DISPLAY_SETTINGS.compact).toBe(false);
  });

  it("đọc đúng cờ compact", () => {
    expect(parseDisplaySettings('{"compact":true}')).toEqual({ compact: true });
    expect(parseDisplaySettings('{"compact":false}')).toEqual({ compact: false });
  });

  it("JSON hỏng / không phải object / sai kiểu → mặc định thay vì ném lỗi", () => {
    expect(parseDisplaySettings("{")).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(parseDisplaySettings("null")).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(parseDisplaySettings("42")).toEqual(DEFAULT_DISPLAY_SETTINGS);
    // Chuỗi "true" không phải boolean: không được đoán bừa thành bật.
    expect(parseDisplaySettings('{"compact":"true"}')).toEqual({ compact: false });
  });

  it("bỏ qua khoá lạ (dữ liệu của phiên bản khác)", () => {
    expect(parseDisplaySettings('{"compact":true,"fontSize":"huge"}')).toEqual({ compact: true });
  });
});

describe("read/save", () => {
  it("lưu rồi đọc lại ra cùng giá trị", () => {
    saveDisplaySettings({ compact: true });
    expect(localStorage.getItem(DISPLAY_SETTINGS_KEY)).toBe('{"compact":true}');
    expect(readDisplaySettings()).toEqual({ compact: true });
  });

  it("chưa có key → mặc định", () => {
    expect(readDisplaySettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it("giá trị rác trong storage không làm hỏng lần đọc", () => {
    localStorage.setItem(DISPLAY_SETTINGS_KEY, "không phải json");
    expect(readDisplaySettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });
});
