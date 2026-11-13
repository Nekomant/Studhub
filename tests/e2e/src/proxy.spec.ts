import { expect, test } from "@playwright/test";

// Тест идёт против vite preview собранной SPA. Прокси /api в dev-сервере тот же, его проверяет dev.spec.ts.
test("[SH-008 AC-1] запрос к /api/v1 доходит до API через прокси и получает ответ API, а не страницу SPA", async ({
  request,
}) => {
  const response = await request.get("/api/v1/nothing-here");

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "not_found" });
});

test("[SH-008 AC-1] SPA запрашивает /healthz на своём адресе, а не у API напрямую", async ({ page }) => {
  const origins: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/healthz") origins.push(url.origin);
  });

  await page.goto("/today");
  await expect(page.getByRole("status")).toContainText("Сервер доступен");

  expect(origins).toEqual([new URL(page.url()).origin]);
});
