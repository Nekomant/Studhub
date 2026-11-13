import { expect, test } from "@playwright/test";

// Админка платформы (apps/admin, SH-076) пока заглушка. Playwright открывает её на своём порту (проект admin).
test.describe("[SH-076 AC-2] заглушка админки платформы", () => {
  test("[SH-076 AC-2] страница показывает заголовок и пометку о заглушке", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("Админка платформы");
    await expect(page.getByRole("heading", { level: 1, name: "Админка платформы" })).toBeVisible();
    await expect(page.getByText("Заглушка: экраны появятся в следующих задачах")).toBeVisible();
  });

  test("[SH-076 AC-2] страница не делает запросов к /api и к внешним доменам", async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? "").origin;
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Админка платформы" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const external = urls.filter((url) => {
      const { protocol, origin: requestOrigin } = new URL(url);
      return protocol !== "data:" && protocol !== "blob:" && requestOrigin !== origin;
    });
    expect(external).toEqual([]);
    expect(urls.filter((url) => new URL(url).pathname.startsWith("/api"))).toEqual([]);

    // Проверка не пустая: скрипт страницы пришёл с нашего домена.
    expect(urls.some((url) => url.endsWith(".js"))).toBe(true);
  });

  test("[SH-076 AC-2] страница не просит вход и не показывает данных", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("link")).toHaveCount(0);
  });
});
