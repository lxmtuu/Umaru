import { UmaruApi, type AuthResult } from "@umaru/sdk";

const ACCESS_KEY = "umaru.access";
const REFRESH_KEY = "umaru.refresh";

let accessToken: string | null = read(ACCESS_KEY);
let refreshToken: string | null = read(REFRESH_KEY);
let refreshInFlight: Promise<boolean> | null = null;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* chế độ riêng tư: bỏ qua, session chỉ sống trong tab */
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function storeTokens(result: AuthResult): void {
  accessToken = result.accessToken;
  refreshToken = result.refreshToken;
  write(ACCESS_KEY, accessToken);
  write(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
}

export const api = new UmaruApi({ baseUrl: "", getToken: getAccessToken });

/** Đổi refresh token (rotation) — dùng chung cho retry và cho lúc khởi động. */
export async function refreshSession(): Promise<boolean> {
  if (refreshToken === null) return false;
  refreshInFlight ??= (async () => {
    try {
      const result = await api.refresh(refreshToken as string);
      storeTokens(result);
      return true;
    } catch {
      clearTokens();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * fetch có tự refresh một lần khi gặp 401. Access token sống 15 phút nên
 * tab mở lâu vẫn phải hoạt động mà không bắt người dùng đăng nhập lại.
 */
const authedFetch: typeof fetch = async (input, init) => {
  const original = await fetch(input, init);
  if (original.status !== 401 || refreshToken === null) return original;

  const url = String(input);
  if (url.includes("/auth/")) return original;

  const refreshed = await refreshSession();
  if (!refreshed) return original;

  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set("authorization", `Bearer ${accessToken ?? ""}`);
  return fetch(input, { ...init, headers });
};

export const authedApi = new UmaruApi({ baseUrl: "", getToken: getAccessToken, fetchImpl: authedFetch });
