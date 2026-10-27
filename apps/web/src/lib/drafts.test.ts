import { describe, expect, it } from "vitest";
import {
  MAX_DRAFT_CHANNELS,
  MAX_DRAFT_LENGTH,
  clearDrafts,
  draftsFromStorageEvent,
  draftsKey,
  readDrafts,
  writeDraft,
  type DraftStorage,
} from "./drafts.js";

/**
 * Nháp tin theo kênh.
 *
 * Ba thứ dễ hỏng mà test này giữ:
 *  - nháp **rò giữa hai tài khoản** trên cùng trình duyệt (khoá phải theo userId);
 *  - JSON rác làm trắng app (mất nháp còn hơn màn hình trắng);
 *  - `localStorage` đầy/không có (`setItem` ném lỗi) làm hỏng việc gửi tin.
 */
function memoryStorage(initial: Record<string, string> = {}): DraftStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? (data[key] as string) : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("drafts", () => {
  it("khoá theo tài khoản — hai người dùng cùng máy không thấy nháp của nhau", () => {
    const storage = memoryStorage();
    writeDraft(storage, "user-a", "100", "nháp của A");
    expect(readDrafts(storage, "user-a")).toEqual({ "100": "nháp của A" });
    expect(readDrafts(storage, "user-b")).toEqual({});
    expect(draftsKey("user-a")).not.toBe(draftsKey("user-b"));
  });

  it("ghi rồi đọc lại đúng nội dung, nhiều kênh độc lập", () => {
    const storage = memoryStorage();
    writeDraft(storage, "u", "100", "một");
    writeDraft(storage, "u", "200", "hai");
    expect(readDrafts(storage, "u")).toEqual({ "100": "một", "200": "hai" });
  });

  it("chuỗi rỗng hoặc chỉ khoảng trắng = xoá nháp", () => {
    const storage = memoryStorage();
    writeDraft(storage, "u", "100", "đang gõ");
    expect(writeDraft(storage, "u", "100", "")).toEqual({});
    expect(storage.data[draftsKey("u")]).toBeUndefined();

    writeDraft(storage, "u", "100", "đang gõ");
    expect(writeDraft(storage, "u", "100", "   \n  ")).toEqual({});
  });

  it("cắt về trần 2 000 ký tự (đúng giới hạn server)", () => {
    const storage = memoryStorage();
    writeDraft(storage, "u", "100", "a".repeat(5000));
    expect(readDrafts(storage, "u")["100"]).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it("quá 40 kênh thì đẩy kênh **cũ nhất** ra, giữ kênh mới", () => {
    const storage = memoryStorage();
    for (let index = 0; index < MAX_DRAFT_CHANNELS; index += 1) {
      writeDraft(storage, "u", `chan-${index}`, `nháp ${index}`, 1000 + index);
    }
    const drafts = writeDraft(storage, "u", "chan-moi", "mới nhất", 9999);
    expect(Object.keys(drafts)).toHaveLength(MAX_DRAFT_CHANNELS);
    expect(drafts["chan-0"]).toBeUndefined();
    expect(drafts["chan-moi"]).toBe("mới nhất");
  });

  it("ghi đè nháp cũ thì kênh đó thành mới nhất (không bị đẩy ra oan)", () => {
    const storage = memoryStorage();
    writeDraft(storage, "u", "a", "cũ", 1);
    writeDraft(storage, "u", "b", "khác", 2);
    writeDraft(storage, "u", "a", "vừa sửa", 3);
    // `a` mới hơn `b` ⇒ khi vượt trần đúng một chỗ thì `b` bị đẩy ra trước.
    for (let index = 0; index < MAX_DRAFT_CHANNELS - 1; index += 1) {
      writeDraft(storage, "u", `fill-${index}`, "x", 10 + index);
    }
    const drafts = readDrafts(storage, "u");
    expect(drafts["a"]).toBe("vừa sửa");
    expect(drafts["b"]).toBeUndefined();
  });

  it("JSON rác / đúng kiểu sai → coi như không có nháp, không ném lỗi", () => {
    const cases = [
      "không phải json",
      "[]",
      "null",
      '{"100": "chuỗi trần"}',
      '{"100": {"text": 42}}',
      '{"100": {"text": "   "}}',
    ];
    for (const raw of cases) {
      const storage = memoryStorage({ [draftsKey("u")]: raw });
      expect(() => readDrafts(storage, "u")).not.toThrow();
      expect(readDrafts(storage, "u")).toEqual({});
    }
  });

  it("bản ghi cũ thiếu `at` vẫn đọc được (mặc định 0)", () => {
    const storage = memoryStorage({
      [draftsKey("u")]: JSON.stringify({ "100": { text: "nháp cũ" } }),
    });
    expect(readDrafts(storage, "u")).toEqual({ "100": "nháp cũ" });
  });

  it("localStorage ném lỗi (đầy / bị chặn) thì không làm hỏng gì", () => {
    const broken: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(() => writeDraft(broken, "u", "100", "chữ")).not.toThrow();
    expect(() => clearDrafts(broken, "u")).not.toThrow();
  });

  it("clearDrafts chỉ xoá của đúng tài khoản đó", () => {
    const storage = memoryStorage();
    writeDraft(storage, "a", "100", "của a");
    writeDraft(storage, "b", "100", "của b");
    clearDrafts(storage, "a");
    expect(readDrafts(storage, "a")).toEqual({});
    expect(readDrafts(storage, "b")).toEqual({ "100": "của b" });
  });
});

describe("draftsFromStorageEvent", () => {
  it("sự kiện của khoá khác → null (không đụng nháp)", () => {
    expect(draftsFromStorageEvent({ key: "umaru.locale", newValue: "vi" }, "u")).toBeNull();
    expect(draftsFromStorageEvent({ key: draftsKey("khác"), newValue: "{}" }, "u")).toBeNull();
  });

  it("tab khác ghi nháp → đọc ra đúng bản đồ", () => {
    const storage = memoryStorage();
    writeDraft(storage, "u", "100", "chữ của tab kia");
    writeDraft(storage, "u", "200", "kênh khác");
    const event = { key: draftsKey("u"), newValue: storage.getItem(draftsKey("u")) };
    expect(draftsFromStorageEvent(event, "u")).toEqual({
      "100": "chữ của tab kia",
      "200": "kênh khác",
    });
  });

  it("tab khác xoá hết nháp (newValue null) → bản đồ rỗng", () => {
    expect(draftsFromStorageEvent({ key: draftsKey("u"), newValue: null }, "u")).toEqual({});
  });

  it("localStorage.clear() (key null) → bản đồ rỗng", () => {
    expect(draftsFromStorageEvent({ key: null, newValue: null }, "u")).toEqual({});
  });

  it("JSON rác từ tab khác → rỗng, không ném lỗi", () => {
    expect(
      draftsFromStorageEvent({ key: draftsKey("u"), newValue: "{không phải json" }, "u"),
    ).toEqual({});
  });
});
