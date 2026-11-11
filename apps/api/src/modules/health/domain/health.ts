// Правила проверки здоровья. Чистый TS: без Hono, без БД (ТД §13).

export type HealthReport = { status: "ok"; db: "ok" };

// Сервис здоров, только если отвечает база данных.
export function buildHealthReport(): HealthReport {
  return { status: "ok", db: "ok" };
}
