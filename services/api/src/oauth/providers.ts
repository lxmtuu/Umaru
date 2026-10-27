import { HttpError } from "../http.js";

/**
 * Hai nhà cung cấp OAuth2 được hỗ trợ.
 *
 * Chỉ hai, và cố ý: mỗi provider là một bề mặt tấn công (redirect URI, cách họ
 * trả email đã xác thực hay chưa, tỉ lệ đổi API). Thêm provider mới = thêm một
 * file test, không phải thêm một nhánh `if` rải rác.
 */
export type OAuthProviderId = "google" | "github";

export const OAUTH_PROVIDERS: OAuthProviderId[] = ["google", "github"];

export function isOAuthProvider(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as string[]).includes(value);
}

export function providerLabel(provider: OAuthProviderId): string {
  return provider === "google" ? "Google" : "GitHub";
}

/** Hồ sơ đã chuẩn hoá — mọi khác biệt giữa hai provider dừng lại ở file này. */
export interface OAuthProfile {
  /** ID bên provider (Google `sub`, GitHub `id`) — đã chuyển thành chuỗi. */
  providerUserId: string;
  email: string | null;
  /** Provider **khẳng định** email này đã xác thực. Sai cờ này thì không liên kết. */
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export interface OAuthHttpContext {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Cho test bơm fetch giả; mặc định là `globalThis.fetch`. */
  fetch: typeof fetch;
  /** Trần thời gian một lời gọi ra ngoài (mặc định 8 giây). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Request ra ngoài luôn có timeout: provider treo không được treo luồng đăng nhập. */
async function callFetch(
  ctx: OAuthHttpContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await ctx.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // Không log token/secret: chỉ nói "không gọi được provider".
    throw new HttpError(
      502,
      "OAUTH_PROVIDER_ERROR",
      `Không gọi được ${url} (${(error as Error).message})`,
    );
  }
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** URL trang đồng ý của provider. `state` chống CSRF, do server sinh. */
export function buildAuthorizeUrl(
  provider: OAuthProviderId,
  options: { clientId: string; redirectUri: string; state: string },
): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    response_type: "code",
  });
  if (provider === "google") {
    params.set("scope", "openid email profile");
    // `select_account`: máy dùng chung không tự vào tài khoản đang đăng nhập sẵn.
    params.set("prompt", "select_account");
    params.set("access_type", "online");
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  params.set("scope", "read:user user:email");
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Đổi `code` lấy hồ sơ người dùng.
 *
 * Ba bước ở cả hai provider: code → access token → hồ sơ. Google trả email kèm
 * `email_verified` trong `userinfo`; GitHub thì phải hỏi thêm `/user/emails` vì
 * `/user` trả `email: null` khi người dùng để email ở chế độ riêng tư — và đó
 * chính là lúc cần biết email nào **đã xác thực** để quyết định có liên kết
 * tài khoản cũ hay không.
 */
export async function exchangeCodeForProfile(
  provider: OAuthProviderId,
  ctx: OAuthHttpContext,
  code: string,
): Promise<OAuthProfile> {
  if (provider === "google") {
    const tokenResponse = await callFetch(ctx, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: ctx.clientId,
        client_secret: ctx.clientSecret,
        redirect_uri: ctx.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    const token = await readJson(tokenResponse);
    const accessToken = asString(token.access_token);
    if (!tokenResponse.ok || accessToken === null) {
      throw new HttpError(502, "OAUTH_PROVIDER_ERROR", "Google từ chối đổi mã đăng nhập");
    }
    const infoResponse = await callFetch(ctx, "https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const info = await readJson(infoResponse);
    const sub = asString(info.sub);
    if (!infoResponse.ok || sub === null) {
      throw new HttpError(502, "OAUTH_PROVIDER_ERROR", "Google không trả hồ sơ người dùng");
    }
    // Google có thể trả `email_verified` dạng chuỗi — nhận cả hai kiểu, nhưng chỉ
    // đúng giá trị "true" mới tính là đã xác thực (mặc định phải là **không**).
    const rawVerified = info.email_verified;
    const verified = rawVerified === true || rawVerified === "true";
    return {
      providerUserId: sub,
      email: asString(info.email)?.toLowerCase() ?? null,
      emailVerified: verified,
      displayName: asString(info.name) ?? asString(info.email) ?? "Người dùng Google",
      avatarUrl: asString(info.picture),
    };
  }

  const tokenResponse = await callFetch(ctx, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      redirect_uri: ctx.redirectUri,
    }).toString(),
  });
  const token = await readJson(tokenResponse);
  const accessToken = asString(token.access_token);
  if (!tokenResponse.ok || accessToken === null) {
    throw new HttpError(502, "OAUTH_PROVIDER_ERROR", "GitHub từ chối đổi mã đăng nhập");
  }
  // GitHub **bắt buộc** có `User-Agent`, thiếu là 403 khó hiểu.
  const headers = { authorization: `Bearer ${accessToken}`, "user-agent": "Umaru", accept: "application/vnd.github+json" };
  const userResponse = await callFetch(ctx, "https://api.github.com/user", { headers });
  const user = await readJson(userResponse);
  const id = asString(user.id);
  if (!userResponse.ok || id === null) {
    throw new HttpError(502, "OAUTH_PROVIDER_ERROR", "GitHub không trả hồ sơ người dùng");
  }

  let email = asString(user.email)?.toLowerCase() ?? null;
  let emailVerified = false;
  // `/user` chỉ trả email công khai và **không** nói đã xác thực hay chưa ⇒ luôn
  // hỏi `/user/emails` để lấy cờ `verified` thật.
  const emailResponse = await callFetch(ctx, "https://api.github.com/user/emails", { headers });
  if (emailResponse.ok) {
    const list = await emailResponse.json().catch(() => []);
    if (Array.isArray(list)) {
      const rows = list as Array<Record<string, unknown>>;
      const verified = rows.find(
        (row) => row.primary === true && row.verified === true && asString(row.email) !== null,
      );
      const anyVerified = verified ?? rows.find((row) => row.verified === true);
      if (anyVerified !== undefined) {
        email = (asString(anyVerified.email) ?? email)?.toLowerCase() ?? email;
        emailVerified = true;
      }
    }
  }

  return {
    providerUserId: id,
    email,
    emailVerified,
    displayName: asString(user.name) ?? asString(user.login) ?? "Người dùng GitHub",
    avatarUrl: asString(user.avatar_url),
  };
}
