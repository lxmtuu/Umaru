import { useEffect, useRef } from "react";
import { AdminReportsPage } from "./components/AdminReportsPage.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { LegalPage } from "./components/LegalPage.js";
import { ChatScreen } from "./components/ChatScreen.js";
import { useChat } from "./lib/chatStore.js";
import { readAdminRoute } from "./lib/adminRoute.js";
import { readLegalRoute } from "./lib/legalRoute.js";
import { useT } from "./lib/i18n.js";

export default function App() {
  const t = useT();
  const screen = useChat((state) => state.screen);
  const booted = useRef(false);
  /** `/terms` và `/privacy` mở được cả khi chưa đăng nhập nên kiểm trước khi boot. */
  const legalDoc =
    typeof window === "undefined" ? null : readLegalRoute(window.location.pathname);
  /** Khu quản trị: cần phiên đăng nhập (App vẫn boot như bình thường). */
  const adminRoute =
    typeof window === "undefined" ? null : readAdminRoute(window.location.pathname);

  useEffect(() => {
    // Trang pháp lý tĩnh: không cần phiên, không cần kết nối gateway.
    if (legalDoc !== null || booted.current) return;
    booted.current = true;
    void useChat.getState().boot();
  }, [legalDoc]);

  if (legalDoc !== null) {
    return <LegalPage doc={legalDoc} />;
  }

  if (adminRoute !== null) {
    // Vẫn cần boot để biết phiên + quyền; lúc đang boot thì trang tự hiện "đang tải".
    return <AdminReportsPage />;
  }

  if (screen === "boot") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-400">
        {t("loading")}
      </div>
    );
  }

  return screen === "auth" ? <AuthScreen /> : <ChatScreen />;
}
