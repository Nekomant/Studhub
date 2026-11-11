import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

// Тесты на реальном Postgres из TEST_DATABASE_URL. Перед каждым тестом схема public пересоздаётся.
const apiRoot = resolve(import.meta.dirname, "../..");
const testUrl = process.env.TEST_DATABASE_URL ?? "postgres://studhub:change-me-local@localhost:5432/studhub_test";

// Окружение дочерних процессов: DATABASE_URL указывает на тестовую БД, остальные переменные нужны для проверки конфига.
const childEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: testUrl,
  S3_ENDPOINT: "http://localhost:3900",
  S3_REGION: "garage",
  S3_BUCKET: "studhub-files",
  S3_ACCESS_KEY_ID: "local-access-key",
  S3_SECRET_ACCESS_KEY: "local-secret-key",
};

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetTestDatabase(): Promise<void> {
  const name = new URL(testUrl).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`тестовая БД должна оканчиваться на _test, сейчас «${name}»`);
  await withClient((client) =>
    client.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"),
  );
}

// Журнал применённых миграций, который ведёт drizzle.
async function ledger(): Promise<unknown[]> {
  return withClient(async (client) => {
    const result = await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id");
    return result.rows;
  });
}

async function hasExtension(name: string): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = $1", [name]);
    return result.rowCount === 1;
  });
}

function runPnpmScript(script: string) {
  return spawnSync("pnpm", ["run", script], { cwd: apiRoot, env: childEnv, encoding: "utf8", timeout: 120_000 });
}

function runMigrateCommand() {
  return spawnSync(process.execPath, ["src/main.ts", "migrate"], {
    cwd: apiRoot,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("миграции БД", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("[SH-005 AC-1] db:migrate применяет миграции к пустой БД, повторный запуск ничего не меняет", async () => {
    const first = runPnpmScript("db:migrate");
    expect(first.status, first.stderr).toBe(0);
    const applied = await ledger();
    expect(applied.length).toBeGreaterThan(0);
    expect(await hasExtension("pg_trgm")).toBe(true);

    const second = runPnpmScript("db:migrate");
    expect(second.status, second.stderr).toBe(0);
    expect(await ledger()).toEqual(applied);
  });

  it("[SH-005 AC-2] db:check проходит без изменений схемы и падает, если схема изменена без миграции", () => {
    const clean = runPnpmScript("db:check");
    expect(clean.status, clean.stderr).toBe(0);

    const changed = spawnSync("node", ["scripts/db-check.mjs", "--schema", "test/fixtures/unmigrated-schema.ts"], {
      cwd: apiRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(changed.status).not.toBe(0);
    expect(`${changed.stdout}${changed.stderr}`).toContain("db:generate");
  });

  it("[SH-005 AC-3] команда migrate собранного приложения применяет миграции и завершает процесс", async () => {
    const first = runMigrateCommand();
    expect(first.status, first.stderr).toBe(0);
    const applied = await ledger();
    expect(applied.length).toBeGreaterThan(0);

    const second = runMigrateCommand();
    expect(second.status, second.stderr).toBe(0);
    expect(await ledger()).toEqual(applied);
  });
});
