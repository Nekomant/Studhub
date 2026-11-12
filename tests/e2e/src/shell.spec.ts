import { expect, test } from "@playwright/test";
import { moreScreens, navigationName, tabScreens } from "./support/screens.ts";

const phone = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

test.describe("[SH-008 AC-2] оболочка на телефоне: нижняя панель", () => {
  test.use({ viewport: phone });

  test("[SH-008 AC-2] при ширине 375 px видна только нижняя панель с пятью вкладками", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/today$/);

    const navigation = page.getByRole("navigation", { name: navigationName });
    await expect(navigation).toHaveCount(1);
    await expect(navigation.getByRole("link")).toHaveText(tabScreens.map((tab) => tab.name));

    const box = await navigation.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(phone.width);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBe(phone.height);
  });

  test("[SH-008 AC-2] нажатие на вкладку открывает её экран, активная вкладка помечена", async ({ page }) => {
    await page.goto("/today");
    const navigation = page.getByRole("navigation", { name: navigationName });

    for (const tab of tabScreens) {
      await navigation.getByRole("link", { name: tab.name }).click();
      await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
      await expect(page.getByRole("heading", { level: 1, name: tab.name })).toBeVisible();
      await expect(navigation.getByRole("link", { name: tab.name })).toHaveAttribute("aria-current", "page");
      await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    }
  });

  test("[SH-008 AC-2] при ширине 767 px панель нижняя", async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto("/today");
    const box = await page.getByRole("navigation", { name: navigationName }).boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBe(800);
    expect(box?.width).toBe(767);
  });
});

test.describe("[SH-008 AC-2] оболочка на компьютере: боковая панель", () => {
  test.use({ viewport: desktop });

  test("[SH-008 AC-2] при ширине 1280 px видна только боковая панель без вкладки «Ещё»", async ({ page }) => {
    await page.goto("/today");

    const navigation = page.getByRole("navigation", { name: navigationName });
    await expect(navigation).toHaveCount(1);
    await expect(navigation.getByRole("link")).toHaveText([
      "Сегодня",
      "Расписание",
      "Ученики",
      "Материалы",
      "Оплаты и отчёт",
      "Шаблоны",
      "Настройки",
    ]);
    await expect(navigation.getByRole("link", { name: "Ещё", exact: true })).toHaveCount(0);

    const box = await navigation.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.y).toBe(0);
    expect(box?.height).toBe(desktop.height);
    expect(box?.width).toBeLessThan(desktop.width / 2);
  });

  test("[SH-008 AC-2] при ширине 768 px панель боковая", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/today");
    const box = await page.getByRole("navigation", { name: navigationName }).boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.height).toBe(800);
    expect(box?.width).toBeLessThan(384);
  });

  test("[SH-008 AC-2] пункт боковой панели открывает экран, активный пункт помечен", async ({ page }) => {
    await page.goto("/today");
    const navigation = page.getByRole("navigation", { name: navigationName });

    for (const screen of [...tabScreens.filter((tab) => tab.path !== "/more"), ...moreScreens]) {
      await navigation.getByRole("link", { name: screen.name }).click();
      await expect(page).toHaveURL(new RegExp(`${screen.path}$`));
      await expect(page.getByRole("heading", { level: 1, name: screen.name })).toBeVisible();
      await expect(navigation.getByRole("link", { name: screen.name })).toHaveAttribute("aria-current", "page");
    }
  });
});

test.describe("[SH-008 AC-2] адреса экранов по screens.md §3.2", () => {
  test("[SH-008 AC-2] каждый адрес открывает заглушку с заголовком экрана", async ({ page }) => {
    for (const screen of [...tabScreens, ...moreScreens]) {
      await page.goto(screen.path);
      await expect(page.getByRole("heading", { level: 1, name: screen.name })).toBeVisible();
    }
  });

  test("[SH-008 AC-2] корень «/» ведёт на «Сегодня»", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/today$/);
  });

  test("[SH-008 AC-2] на вложенном экране вкладка «Ещё» активна, её нажатие возвращает к корневому экрану", async ({
    page,
  }) => {
    await page.setViewportSize(phone);
    await page.goto("/more/payments");
    const more = page.getByRole("navigation", { name: navigationName }).getByRole("link", { name: "Ещё" });
    await expect(more).toHaveAttribute("aria-current", "page");
    await more.click();
    await expect(page).toHaveURL(/\/more$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ещё" })).toBeVisible();
  });
});
