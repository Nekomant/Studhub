import { defineConfig } from "vitest/config";

// Один запуск `pnpm test` проходит по всем проектам. Пакет без своего
// vitest.config.ts берёт настройки по умолчанию. tests/e2e запускает Playwright,
// поэтому его здесь нет.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      "apps/api",
      "apps/web",
      "packages/client-core",
      "tests/api",
      { test: { name: "tools", include: ["tools/tests/**/*.test.ts"] } },
    ],
  },
});
