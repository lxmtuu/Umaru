import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Parser markdown + store là logic thuần, không cần DOM.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
