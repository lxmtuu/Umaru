import type { Snowflake } from "@umaru/protocol";
import type { AuthResult } from "@umaru/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test cho lớp phiên đăng nhập.
 *
 * Bối cảnh: trên preview, sau khi đăng nhập thành công (200) mà request kế tiếp
 * vẫn 401 "Thiếu access token" — nguyên nhân là token chỉ nằm trong biến module,
 * nên khi module bị **đánh giá lại** (HMR) token biến mất trong khi trang vẫn
 * đang chạy. Bộ test này khoá lại hành vi: token phải sống trong `globalThis`
 * (dùng chung giữa các instance module) và phải tự phục hồi từ storage.
 */

interface StorageStub {
  fail: boolean;
  data: Map<string, string>;
}

let storageStub: StorageStub;

function installStorage(fail = false): StorageStub {
  storageStub = { fail, data: new Map() };
  const stub = {
    getItem(key: string) {
      if (storageStub.fail) throw new Error("SecurityError: storage bị chặn");
      return storageStub.data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (storageStub.fail) throw new Error("SecurityError: storage bị chặn");
      storageStub.data.set(key, value);
    },
    removeItem(key: string) {
      if (storageStub.fail) throw new Error("SecurityError: storage bị chặn");
      storageStub.data.delete(key);
    },
  };
  vi.stubGlobal("localStorage", stub);
  return storageStub;
}

const AUTH: AuthResult = {
  user: {
    id: "1" as Snowflake,
    username: "demo",
    displayName: "Demo",
    avatarUrl: null,
    status: "offline",
    emailVerified: true,
    createdAt: new Date().toISOString(),
  },
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  tokenType: "Bearer",
  expiresIn: 900,
};

/** Nạp lại module như một instance mới (mô phỏng HMR đánh giá lại file). */
async function freshSession() {
  vi.resetModules();
  return import("./session.js");
}

beforeEach(() => {
  installStorage();
  delete (globalThis as Record<string, unknown>)["__umaruAuthTokens"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("token trong phiên", () => {
  it("lưu và đọc token, ghi cả vào storage", async () => {
    const session = await freshSession();
    session.storeTokens(AUTH);

    expect(session.getAccessToken()).toBe("access-token-1");
    expect(session.getRefreshToken()).toBe("refresh-token-1");
    expect(storageStub.data.get("umaru.access")).toBe("access-token-1");
    expect(storageStub.data.get("umaru.refresh")).toBe("refresh-token-1");
  });

  it("token sống sót khi module bị đánh giá lại (HMR) — đúng lỗi trên preview", async () => {
    const first = await freshSession();
    first.storeTokens(AUTH);

    // Instance thứ hai: biến module reset, nhưng globalThis thì không.
    const second = await freshSession();
    expect(second.getAccessToken()).toBe("access-token-1");
    expect(second.getRefreshToken()).toBe("refresh-token-1");

    // Và request đi qua instance mới vẫn có header token.
    const { authedApi } = second;
    const calls: { url: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(input), auth: headers.authorization });
        return new Response(JSON.stringify(AUTH.user), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    );
    await authedApi.getCurrentUser();
    expect(calls[0]?.auth).toBe("Bearer access-token-1");
  });

  it("storage bị chặn (chế độ riêng tư) vẫn dùng được trong trang", async () => {
    installStorage(true);
    const session = await freshSession();
    expect(() => session.storeTokens(AUTH)).not.toThrow();
    expect(session.getAccessToken()).toBe("access-token-1");
    // Đánh giá lại module vẫn còn token nhờ globalThis, dù storage không ghi được.
    const second = await freshSession();
    expect(second.getAccessToken()).toBe("access-token-1");
  });

  it("getAccessToken tự phục hồi từ storage khi RAM trống", async () => {
    installStorage();
    storageStub.data.set("umaru.access", "token-tu-storage");
    delete (globalThis as Record<string, unknown>)["__umaruAuthTokens"];
    const session = await freshSession();
    expect(session.getAccessToken()).toBe("token-tu-storage");
  });

  it("clearTokens xoá cả bộ nhớ lẫn storage", async () => {
    const session = await freshSession();
    session.storeTokens(AUTH);
    session.clearTokens();
    expect(session.getAccessToken()).toBeNull();
    expect(session.getRefreshToken()).toBeNull();
    expect(storageStub.data.has("umaru.access")).toBe(false);
    expect(storageStub.data.has("umaru.refresh")).toBe(false);
  });
});

describe("tự refresh khi 401", () => {
  it("401 → refresh → gọi lại đúng một lần với token mới (cả 2 header)", async () => {
    const session = await freshSession();
    session.storeTokens(AUTH);

    const calls: { url: string; method?: string; auth?: string | null; alias?: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // Retry gửi `Headers` object, request đầu gửi plain object → chuẩn hoá.
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        calls.push({
          url,
          method: init?.method,
          auth: headers.get("authorization"),
          alias: headers.get("x-umaru-token"),
        });
        if (url.includes("/auth/refresh")) {
          return new Response(
            JSON.stringify({ ...AUTH, accessToken: "access-token-2", refreshToken: "refresh-2" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (calls.filter((call) => call.url.includes("/users/@me")).length === 1) {
          return new Response(JSON.stringify({ error: { message: "hết hạn" } }), { status: 401 });
        }
        return new Response(JSON.stringify(AUTH.user), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    );

    await session.authedApi.getCurrentUser();

    expect(calls.map((call) => call.url.replace(/^.*\/api\/v1/, ""))).toEqual([
      "/users/@me",
      "/auth/refresh",
      "/users/@me",
    ]);
    expect(calls[2]?.auth).toBe("Bearer access-token-2");
    expect(calls[2]?.alias).toBe("access-token-2");
    // Refresh token đã xoay vòng.
    expect(session.getRefreshToken()).toBe("refresh-2");
  });

  it("không retry cho endpoint /auth/ (tránh vòng lặp khi sai mật khẩu)", async () => {
    const session = await freshSession();
    session.storeTokens(AUTH);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ error: { message: "sai" } }), { status: 401 });
      }) as typeof fetch,
    );

    await session.authedApi.login("a@b.c", "sai-mat-khau").catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("refresh thất bại thì xoá phiên và trả 401 gốc", async () => {
    const session = await freshSession();
    session.storeTokens(AUTH);
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/refresh")) {
          return new Response(JSON.stringify({ error: { message: "refresh chết" } }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ error: { message: "hết hạn" } }), { status: 401 });
      }) as typeof fetch,
    );

    await expect(session.authedApi.getCurrentUser()).rejects.toThrow();
    expect(session.getAccessToken()).toBeNull();
    expect(session.getRefreshToken()).toBeNull();
  });
});
