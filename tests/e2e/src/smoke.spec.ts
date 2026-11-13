import { expect, test } from "@playwright/test";

test("[SH-008 AC-4] smoke: собранное приложение открывается, элементы находятся по ролям и текстам", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Studhub");
  await expect(page.getByRole("heading", { level: 1, name: "Сегодня" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  await expect(page.getByText("Сервер доступен")).toBeVisible();
});

test("[SH-008 AC-4] тест идёт против сборки, а не dev-сервера", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Сегодня" })).toBeVisible();

  // dev-сервер Vite добавляет клиент горячей замены, сборка его не содержит.
  await expect(page.locator('script[src*="@vite/client"]')).toHaveCount(0);
  const scripts = await page
    .locator("script[src]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) expect(src).toMatch(/^\/assets\/.+-[\w-]{6,}\.js$/);
});
