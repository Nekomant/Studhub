import { expect, test } from "@playwright/test";
import { moreScreens, tabScreens } from "./support/screens.ts";

// ТД §9: нет внешних CDN, шрифты раздаём сами. Тест собирает все запросы страницы на всех экранах.
test("[SH-008 AC-3] приложение не обращается к внешним доменам", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "").origin;
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  for (const screen of [...tabScreens, ...moreScreens]) {
    await page.goto(screen.path);
    await expect(page.getByRole("heading", { level: 1, name: screen.name })).toBeVisible();
  }
  // Шрифты грузятся, когда браузер выводит текст: ждём их, чтобы проверка не была пустой.
  await page.evaluate(() => document.fonts.ready);

  const external = urls.filter((url) => {
    const { protocol, origin: requestOrigin } = new URL(url);
    return protocol !== "data:" && protocol !== "blob:" && requestOrigin !== origin;
  });
  expect(external).toEqual([]);

  // Проверка не пустая: шрифты, скрипты и запрос к API пришли с нашего домена.
  expect(urls.some((url) => url.endsWith(".woff2"))).toBe(true);
  expect(urls.some((url) => url.endsWith(".js"))).toBe(true);
  expect(urls.some((url) => new URL(url).pathname === "/healthz")).toBe(true);
});
