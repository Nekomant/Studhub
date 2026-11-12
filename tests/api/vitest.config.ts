import { defineConfig } from "vitest/config";

// API-тесты запускают приложение дочерним процессом на тестовой БД (src/support). Тестовые файлы идут параллельно:
// каждый файл поднимает своё приложение со своей БД, поэтому данные и часы файлов не пересекаются.
export default defineConfig({
  test: {
    name: "@studhub/tests-api",
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/support/global-setup.ts"],
    fileParallelism: true,
    // Запуск приложения и клонирование БД занимают секунды.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
