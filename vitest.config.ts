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
      "packages/ui-tokens",
      "tests/api",
      // tools запускает настоящий git и скрипты проекта: под нагрузкой не укладывается в 5 секунд по умолчанию.
      { test: { name: "tools", include: ["tools/tests/**/*.test.ts"], testTimeout: 10_000 } },
    ],
  },
});
