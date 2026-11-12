import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToRgb } from "./support/contrast.ts";
import { customProperties, parseLightDark, readSrc } from "./support/css.ts";
import { colorTokens } from "./support/design-system.ts";

// Проверяем вычисленные цвета в настоящем Chromium. Системную тему задаёт emulateMedia.
const tokensCss = readSrc("tokens.css");
const byName = new Map(colorTokens().map((token) => [token.name, token]));
const rgb = (hex: string) => `rgb(${hexToRgb(hex).join(", ")})`;
const expected = (theme: "light" | "dark") => ({
  background: rgb(byName.get("paper")?.[theme] ?? ""),
  color: rgb(byName.get("ink")?.[theme] ?? ""),
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function computed(rootClass: string, system: "light" | "dark") {
  const page = await browser.newPage({ colorScheme: system });
  try {
    await page.setContent(
      `<!doctype html><html class="${rootClass}"><head><style>${tokensCss}</style></head>` +
        `<body><p id="probe" style="background: var(--paper); color: var(--ink)">x</p></body></html>`,
    );
    return await page.$eval("#probe", (el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
  } finally {
    await page.close();
  }
}

describe("[SH-073 AC-2] тема переключается классом на <html>, системную настройку пакет не учитывает", () => {
  it("[SH-073 AC-2] без класса при системной светлой: светлые цвета", async () => {
    expect(await computed("", "light")).toEqual(expected("light"));
  });

  it("[SH-073 AC-2] без класса при системной тёмной: всё равно светлые цвета", async () => {
    expect(await computed("", "dark")).toEqual(expected("light"));
  });

  it("[SH-073 AC-2] класс dark при системной светлой: тёмные цвета", async () => {
    expect(await computed("dark", "light")).toEqual(expected("dark"));
  });

  it("[SH-073 AC-2] класс dark при системной тёмной: тёмные цвета", async () => {
    expect(await computed("dark", "dark")).toEqual(expected("dark"));
  });

  it("[SH-073 AC-2] класс light при системной тёмной: светлые цвета", async () => {
    expect(await computed("light", "dark")).toEqual(expected("light"));
  });

  it("[SH-073 AC-2] CSS пакета не содержит prefers-color-scheme", () => {
    expect(tokensCss).not.toContain("prefers-color-scheme");
    expect(parseLightDark(customProperties(tokensCss).get("--paper") ?? "")).toBeDefined();
  });
});
