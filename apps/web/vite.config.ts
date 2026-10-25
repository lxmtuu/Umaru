import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind mọi interface để chạy được trong container / preview từ xa
    // (127.0.0.1 chỉ dùng được khi trình duyệt cùng máy với dev server).
    host: true,
    port: 5173,
    // Cho phép Host header của môi trường preview (proxy ngoài) — dev local
    // vẫn dùng http://localhost:5173 bình thường.
    allowedHosts: true,
    proxy: {
      // Same-origin ở dev: tránh CORS, và ws gateway đi qua đúng proxy này.
      "/api": {
        target: process.env.UMARU_API_URL ?? "http://127.0.0.1:4000",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
