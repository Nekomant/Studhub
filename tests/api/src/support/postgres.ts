import { randomBytes } from "node:crypto";
import pg from "pg";

// Работа с БД из тестов. Тестовые БД создаются рядом с TEST_DATABASE_URL на том же сервере Postgres.
// Имена оканчиваются на _test: так `pnpm db:reset-test` и проверки безопасности узнают тестовую БД.

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL не задан: API-тесты нужна тестовая БД (см. .env.example, `pnpm db:up`)");
  }
  return url;
}

function withDatabase(url: string, database: string): string {
  const copy = new URL(url);
  copy.pathname = `/${database}`;
  return copy.toString();
}

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

// Основа имён: имя TEST_DATABASE_URL без суффикса _test (studhub_test → studhub).
function nameStem(): string {
  const name = databaseName(testDatabaseUrl());
  if (!name.endsWith("_test") || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `имя БД в TEST_DATABASE_URL должно оканчиваться на _test и состоять из a-z, 0-9, _; сейчас «${name}»`,
    );
  }
  return name.slice(0, -"_test".length);
}

// Уникальное имя БД для прогона или файла. Параллельные прогоны в разных папках не пересекаются.
export function newDatabaseName(kind: "template" | "app"): string {
  return `${nameStem()}_api_${kind}_${randomBytes(6).toString("hex")}_test`;
}

export function urlForDatabase(database: string): string {
  return withDatabase(testDatabaseUrl(), database);
}

export async function queryDatabase(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// DDL уровня сервера идёт через служебную БД postgres.
function adminQuery(sql: string): Promise<Record<string, unknown>[]> {
  return queryDatabase(withDatabase(testDatabaseUrl(), "postgres"), sql);
}

function assertTestName(database: string): void {
  if (!/^[a-z0-9_]+_api_(template|app)_[0-9a-f]+_test$/.test(database)) {
    throw new Error(`отказ: «${database}» не похожа на БД API-тестов`);
  }
}

export async function createDatabase(database: string, template?: string): Promise<void> {
  assertTestName(database);
  if (template) assertTestName(template);
  // Копирование из шаблона не идёт, пока в шаблоне есть соединения: его никто не открывает. Параллельные копии допустимы.
  await adminQuery(`CREATE DATABASE ${database}${template ? ` TEMPLATE ${template}` : ""}`);
}

export async function dropDatabase(database: string): Promise<void> {
  assertTestName(database);
  await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}
