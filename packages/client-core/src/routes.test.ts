import { describe, expect, it } from "vitest";
import { desktopNav, mobileTabs, startPath } from "./routes.ts";

// screens.md §3.1–3.2: пять вкладок на телефоне, пункты боковой панели на компьютере.
describe("[SH-008 AC-2] карта маршрутов", () => {
  it("[SH-008 AC-2] стартовый экран — «Сегодня»", () => {
    expect(startPath).toBe("/today");
  });

  it("[SH-008 AC-2] нижняя панель: пять вкладок с адресами корневых экранов", () => {
    expect(mobileTabs.map(({ label, path }) => [label, path])).toEqual([
      ["Сегодня", "/today"],
      ["Расписание", "/schedule"],
      ["Ученики", "/students"],
      ["Материалы", "/materials"],
      ["Ещё", "/more"],
    ]);
  });

  it("[SH-008 AC-2] боковая панель: четыре вкладки без «Ещё» и пункты «Оплаты и отчёт», «Шаблоны», «Настройки»", () => {
    expect(desktopNav.map(({ label, path }) => [label, path])).toEqual([
      ["Сегодня", "/today"],
      ["Расписание", "/schedule"],
      ["Ученики", "/students"],
      ["Материалы", "/materials"],
      ["Оплаты и отчёт", "/more/payments"],
      ["Шаблоны", "/more/templates"],
      ["Настройки", "/more/settings/profile"],
    ]);
  });
});
