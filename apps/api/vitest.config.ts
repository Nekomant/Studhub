import { defineConfig } from "vitest/config";

// Тесты с БД и миграциями под нагрузкой не укладываются в 5 секунд по умолчанию.
export default defineConfig({
  test: { testTimeout: 10_000 },
});
