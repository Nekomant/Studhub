import { expect, it } from "vitest";

// Фикстура для теста scripts/verify.mjs: зелёный прогон. В общий `pnpm test` не входит.
it("[fixture] зелёный тест", () => {
  expect(1 + 1).toBe(2);
});
