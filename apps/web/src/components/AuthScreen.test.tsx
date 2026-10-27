// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Màn đăng nhập với OAuth2.
 *
 * Trọng tâm là các quy tắc **an toàn/thoả thuận**, không phải màu nút:
 *  - server chưa cấu hình provider thì không có nút nào;
 *  - đăng ký bằng OAuth vẫn phải tick điều khoản (server kiểm lại, nhưng UI phải
 *    không cho bấm khi chưa tick);
 *  - quay về từ provider với tài khoản có 2FA thì form đổi sang ô mã 6 số và
 *    **không** đòi email/mật khẩu (input `required` rỗng sẽ chặn nút gửi).
 */

const startOAuth = vi.hoisted(() => vi.fn(async () => undefined));
const exchangeOAuthCode = vi.hoisted(() => vi.fn(async () => true));
const login = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../lib/session.js", () => ({
  api: { oauthProviders: async () => ({ providers: [] }) },
  authedApi: {},
}));

vi.mock("zustand", async () => {
  const actual = await vi.importActual<typeof import("zustand")>("zustand");
  return { ...actual, create: actual.create };
});

async function bootStore() {
  const { useChat } = await import("../lib/chatStore.js");
  useChat.setState({
    screen: "auth",
    busy: false,
    error: null,
    totpRequired: false,
    oauthPendingCode: null,
    oauthProviders: [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ],
    loadOAuthProviders: async () => undefined,
    startOAuth,
    exchangeOAuthCode,
    login,
  });
  const { AuthScreen } = await import("./AuthScreen.js");
  return AuthScreen;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("AuthScreen — OAuth2", () => {
  it("vẽ một nút cho mỗi provider server báo đang bật", async () => {
    const AuthScreen = await bootStore();
    render(<AuthScreen />);
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeDefined();
  });

  it("server chưa cấu hình provider → không có nút OAuth nào", async () => {
    const AuthScreen = await bootStore();
    const { useChat } = await import("../lib/chatStore.js");
    useChat.setState({ oauthProviders: [] });
    render(<AuthScreen />);
    expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull();
  });

  it("đăng nhập: bấm nút Google là gọi startOAuth", async () => {
    const AuthScreen = await bootStore();
    render(<AuthScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(startOAuth).toHaveBeenCalledWith("google", false));
  });

  it("đăng ký: chưa tick điều khoản thì nút OAuth bị khoá", async () => {
    const AuthScreen = await bootStore();
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole("button", { name: "New here? Create an account" }));
    const google = screen.getByRole("button", { name: "Continue with Google" }) as HTMLButtonElement;
    expect(google.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /read and agree/i }));
    await waitFor(() => expect(google.disabled).toBe(false));
    fireEvent.click(google);
    await waitFor(() => expect(startOAuth).toHaveBeenCalledWith("google", true));
  });

  it("OAuth + 2FA: hiện ô mã, ẩn email/mật khẩu, gửi mã thì exchange mã đang chờ", async () => {
    const AuthScreen = await bootStore();
    const { useChat } = await import("../lib/chatStore.js");
    useChat.setState({ totpRequired: true, oauthPendingCode: "ma-dang-cho-1234567890" });
    render(<AuthScreen />);

    // Không còn ô email/mật khẩu (chúng `required` và đang rỗng).
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(await screen.findByText(/Two-factor code for the account/)).toBeDefined();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() =>
      expect(exchangeOAuthCode).toHaveBeenCalledWith("ma-dang-cho-1234567890", "123456"),
    );
    expect(login).not.toHaveBeenCalled();
  });
});
