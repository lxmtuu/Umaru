import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
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
