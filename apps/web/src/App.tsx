import { useEffect, useRef } from "react";
import { AuthScreen } from "./components/AuthScreen.js";
import { ChatScreen } from "./components/ChatScreen.js";
import { useChat } from "./lib/chatStore.js";
import { useT } from "./lib/i18n.js";

export default function App() {
  const t = useT();
  const screen = useChat((state) => state.screen);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void useChat.getState().boot();
  }, []);

  if (screen === "boot") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-400">
        {t("loading")}
      </div>
    );
  }

  return screen === "auth" ? <AuthScreen /> : <ChatScreen />;
}
