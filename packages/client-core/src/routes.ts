// Карта маршрутов приложения (ТД §3, §8). Адреса и подписи по screens.md §3.1–3.2.
// Карта не знает о React: приложение строит из неё маршруты и навигацию.

export type NavKey = "today" | "schedule" | "students" | "materials" | "more" | "payments" | "templates" | "settings";

export type NavEntry = { key: NavKey; label: string; path: string };

const today = { key: "today", label: "Сегодня", path: "/today" } as const satisfies NavEntry;
const schedule = { key: "schedule", label: "Расписание", path: "/schedule" } as const satisfies NavEntry;
const students = { key: "students", label: "Ученики", path: "/students" } as const satisfies NavEntry;
const materials = { key: "materials", label: "Материалы", path: "/materials" } as const satisfies NavEntry;
const more = { key: "more", label: "Ещё", path: "/more" } as const satisfies NavEntry;
const payments = { key: "payments", label: "Оплаты и отчёт", path: "/more/payments" } as const satisfies NavEntry;
const templates = { key: "templates", label: "Шаблоны", path: "/more/templates" } as const satisfies NavEntry;
const settings = { key: "settings", label: "Настройки", path: "/more/settings/profile" } as const satisfies NavEntry;

// Стартовый экран — «Сегодня».
export const startPath = today.path;

// (М) Нижняя панель: пять вкладок.
export const mobileTabs: readonly NavEntry[] = [today, schedule, students, materials, more];

// (Д) Боковая панель: у вкладки «Ещё» на компьютере нет, её пункты стоят отдельно.
export const desktopNav: readonly NavEntry[] = [today, schedule, students, materials, payments, templates, settings];

// Все адреса, для которых приложение заводит маршрут.
export const appRoutes: readonly NavEntry[] = [
  today,
  schedule,
  students,
  materials,
  more,
  payments,
  templates,
  settings,
];
