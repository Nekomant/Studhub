// Адреса и заголовки экранов-заглушек по screens.md §3.1–3.2.
export const tabScreens = [
  { path: "/today", name: "Сегодня" },
  { path: "/schedule", name: "Расписание" },
  { path: "/students", name: "Ученики" },
  { path: "/materials", name: "Материалы" },
  { path: "/more", name: "Ещё" },
] as const;

export const moreScreens = [
  { path: "/more/payments", name: "Оплаты и отчёт" },
  { path: "/more/templates", name: "Шаблоны" },
  { path: "/more/settings/profile", name: "Настройки" },
] as const;

export const navigationName = "Основная навигация";
