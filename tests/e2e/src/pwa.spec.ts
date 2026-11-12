import { expect, test } from "@playwright/test";

test("[SH-008 AC-5] приложение отдаёт web manifest", async ({ page, request }) => {
  await page.goto("/today");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).not.toBeNull();

  const response = await request.get(href ?? "");
  expect(response.status()).toBe(200);
  const manifest = (await response.json()) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    name: "Studhub",
    short_name: "Studhub",
    lang: "ru",
    display: "standalone",
    start_url: "/today",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({ src: expect.any(String) })]));
  expect(typeof manifest.theme_color).toBe("string");
  expect(typeof manifest.background_color).toBe("string");
});

test("[SH-008 AC-5] приложение регистрирует service worker, который кэширует только статику", async ({ page }) => {
  await page.goto("/today");
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(script).toMatch(/\/sw\.js$/);

  // Страница под управлением service worker загружает данные: после перезагрузки статус /healthz идёт через него.
  await page.reload();
  await expect(page.getByText("Сервер доступен")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });

  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((path) => path.startsWith("/api") || path === "/healthz" || path.startsWith("/__test"))).toEqual(
    [],
  );
  for (const path of cached) expect(path).toMatch(/\.(js|css|html|woff2|svg|png|ico|webmanifest)$/);
});
