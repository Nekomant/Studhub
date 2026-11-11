import { expect, it } from "vitest";

// Фикстура для теста scripts/verify.mjs: один зелёный и один упавший тест. В общий `pnpm test` не входит.
it("[fixture] зелёный тест", () => {
  expect(1 + 1).toBe(2);
});

it("[fixture] упавший тест", () => {
  expect("ожидаемая ошибка фикстуры").toBe("другое значение");
});
