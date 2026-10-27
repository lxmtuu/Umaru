import { UmaruApi, type AuthResult } from "@umaru/sdk";

const ACCESS_KEY = "umaru.access";
const REFRESH_KEY = "umaru.refresh";

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
    /* chế độ riêng tư / storage bị chặn: session chỉ sống trong tab */
  }
}

interface TokenState {
  access: string | null;
  refresh: string | null;
}

/**
 * Token đặt trên `globalThis` thay vì biến module.
 *
 * Lý do: trong dev, HMR có thể sinh **hai instance của module này** (bản `?t=`
 * cũ và mới) → `storeTokens()` ghi vào instance A trong khi SDK đang giữ
 * `getToken` của instance B, và mọi request sau đăng nhập đi lên **không kèm
 * token** (401 "Thiếu access token"). Một ô nhớ dùng chung thì mọi bản sao đều
 * thấy cùng token. Vẫn đọc/ghi storage để sống qua lần tải lại trang.
 */
const SHARED_KEY = "__umaruAuthTokens";
const globalStore = globalThis as typeof globalThis & { [SHARED_KEY]?: TokenState };

const tokens: TokenState = (globalStore[SHARED_KEY] ??= {
  access: read(ACCESS_KEY),
  refresh: read(REFRESH_KEY),
});

export function getAccessToken(): string | null {
  // Tự phục hồi nếu RAM trống nhưng storage còn (tab khôi phục từ bfcache).
  if (tokens.access === null) tokens.access = read(ACCESS_KEY);
  return tokens.access;
}

export function getRefreshToken(): string | null {
  if (tokens.refresh === null) tokens.refresh = read(REFRESH_KEY);
  return tokens.refresh;
}

export function storeTokens(result: AuthResult): void {
  tokens.access = result.accessToken;
  tokens.refresh = result.refreshToken;
  write(ACCESS_KEY, tokens.access);
  write(REFRESH_KEY, tokens.refresh);
}

export function clearTokens(): void {
  tokens.access = null;
  tokens.refresh = null;
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
}

export const api = new UmaruApi({ baseUrl: "", getToken: getAccessToken });

let refreshInFlight: Promise<boolean> | null = null;

/** Đổi refresh token (rotation) — dùng chung cho retry và cho lúc khởi động. */
export async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (refreshToken === null) return false;
  refreshInFlight ??= (async () => {
    try {
      const result = await api.refresh(refreshToken);
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
  if (original.status !== 401 || getRefreshToken() === null) return original;

  const url = String(input);
  if (url.includes("/auth/")) return original;

  const refreshed = await refreshSession();
  if (!refreshed) return original;

  const headers = new Headers(init?.headers as HeadersInit | undefined);
  const token = getAccessToken();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-umaru-token", token);
  }
  return fetch(input, { ...init, headers });
};

export const authedApi = new UmaruApi({ baseUrl: "", getToken: getAccessToken, fetchImpl: authedFetch });
