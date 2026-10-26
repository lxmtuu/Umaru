import { ApiError } from "@umaru/sdk";
import { describe, expect, it } from "vitest";
import {
  classifyPushError,
  decodePushPublicKey,
  isValidPushPublicKey,
  pushHintKey,
  pushStatusFrom,
  toPushSubscriptionPayload,
} from "./push.js";

/**
 * Phần quyết định của thông báo đẩy. Không test `PushService`: nó cần
 * `navigator.serviceWorker` và `PushManager` thật — thứ jsdom không có, và tự
 * dựng đồ giả chỉ kiểm được đồ giả. Ở đây khoá lại đúng những chỗ dễ sai.
 */

/** Sinh khoá VAPID "giả" đúng hình dạng: 65 byte, byte đầu 0x04. */
function fakePushKey(): { bytes: Uint8Array; base64url: string } {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let index = 1; index < bytes.length; index += 1) bytes[index] = index;
  return { bytes, base64url: Buffer.from(bytes).toString("base64url") };
}

describe("decodePushPublicKey", () => {
  it("giải mã base64url không padding thành đúng bytes", () => {
    const key = fakePushKey();
    const decoded = decodePushPublicKey(key.base64url);
    expect(decoded.length).toBe(65);
    expect(Array.from(decoded)).toEqual(Array.from(key.bytes));
  });

  it("chấp nhận cả base64 thường (có + /) — một số nơi cấu hình trả dạng này", () => {
    const bytes = new Uint8Array([0x04, 0xfb, 0xff, 0x00, 0x10]);
    const standard = Buffer.from(bytes).toString("base64");
    expect(Array.from(decodePushPublicKey(standard))).toEqual(Array.from(bytes));
  });
});

describe("isValidPushPublicKey", () => {
  it("đúng khoá P-256 không nén (65 byte, 0x04)", () => {
    expect(isValidPushPublicKey(fakePushKey().base64url)).toBe(true);
  });

  it("sai kích thước hoặc byte đầu không phải 0x04 thì không dùng được", () => {
    expect(isValidPushPublicKey(Buffer.from([0x04, 1, 2]).toString("base64url"))).toBe(false);
    const compressed = fakePushKey().bytes.slice();
    compressed[0] = 0x02;
    expect(isValidPushPublicKey(Buffer.from(compressed).toString("base64url"))).toBe(false);
  });

  it("chuỗi rác không làm ném", () => {
    expect(isValidPushPublicKey("")).toBe(false);
    expect(isValidPushPublicKey("!!!không-phải-base64!!!")).toBe(false);
  });
});

describe("pushStatusFrom", () => {
  it("trình duyệt không hỗ trợ / bị chặn quyền là hai trạng thái riêng", () => {
    expect(
      pushStatusFrom({ supported: false, permission: "granted", subscribed: true, serverEnabled: true }),
    ).toBe("unsupported");
    expect(
      pushStatusFrom({ supported: true, permission: "denied", subscribed: true, serverEnabled: true }),
    ).toBe("blocked");
  });

  it("server chưa cấu hình VAPID → unavailable (không phải lỗi người dùng)", () => {
    expect(
      pushStatusFrom({ supported: true, permission: "default", subscribed: false, serverEnabled: false }),
    ).toBe("unavailable");
  });

  it("chỉ 'on' khi vừa có quyền vừa có subscription", () => {
    expect(
      pushStatusFrom({ supported: true, permission: "granted", subscribed: true, serverEnabled: true }),
    ).toBe("on");
    expect(
      pushStatusFrom({ supported: true, permission: "granted", subscribed: false, serverEnabled: true }),
    ).toBe("off");
    expect(
      pushStatusFrom({ supported: true, permission: "default", subscribed: false, serverEnabled: true }),
    ).toBe("off");
  });

  it("mỗi trạng thái có đúng một gợi ý i18n", () => {
    for (const status of ["unsupported", "blocked", "off", "on", "unavailable", "error"] as const) {
      expect(pushHintKey(status)).toMatch(/^pushHint/);
    }
  });
});

describe("toPushSubscriptionPayload", () => {
  it("lấy endpoint và hai khoá từ toJSON của trình duyệt", () => {
    expect(
      toPushSubscriptionPayload({
        endpoint: "https://push.example/1",
        toJSON: () => ({
          endpoint: "https://push.example/1",
          keys: { p256dh: "p", auth: "a" },
        }),
      }),
    ).toEqual({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } });
  });

  it("thiếu khoá → null (để tầng trên báo lỗi rõ nghĩa thay vì gửi body 400)", () => {
    expect(toPushSubscriptionPayload({ endpoint: "e", toJSON: () => ({ endpoint: "e" }) })).toBeNull();
    expect(
      toPushSubscriptionPayload({ endpoint: "e", toJSON: () => ({ endpoint: "e", keys: { p256dh: "p" } }) }),
    ).toBeNull();
    expect(
      toPushSubscriptionPayload({ endpoint: "e", toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }) }),
    ).toEqual({ endpoint: "e", keys: { p256dh: "p", auth: "a" } });
  });
});

describe("classifyPushError", () => {
  it("503 = server chưa cấu hình, không phải trình duyệt chặn", () => {
    expect(classifyPushError(new ApiError(503, "tắt", {}))).toEqual({
      status: "unavailable",
      hintKey: "pushHintUnavailable",
    });
  });

  it("người dùng từ chối quyền → blocked; trình duyệt không hỗ trợ → unsupported", () => {
    expect(classifyPushError({ name: "NotAllowedError" }).status).toBe("blocked");
    expect(classifyPushError({ name: "NotSupportedError" }).status).toBe("unsupported");
  });

  it("lỗi lạ vẫn thành 'error' chứ không ném", () => {
    expect(classifyPushError(null).status).toBe("error");
    expect(classifyPushError(new ApiError(500, "hỏng", {})).status).toBe("error");
  });
});
