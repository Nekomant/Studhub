import { expect, test } from "@playwright/test";

test("[SH-008 AC-1] заглушка показывает статус /healthz, полученный через прокси /api", async ({ page }) => {
  const healthz = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/healthz"));
  await page.goto("/today");

  const response = await healthz;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", db: "ok" });
  await expect(page.getByRole("status")).toContainText("Сервер доступен");
});
