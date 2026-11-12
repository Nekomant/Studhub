import { defineConfig } from "vitest/config";

// Браузерные тесты запускают Chromium из Playwright, первый запуск занимает несколько секунд.
export default defineConfig({
  test: { name: "ui-tokens", include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
