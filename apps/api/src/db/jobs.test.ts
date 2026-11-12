import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobs } from "../platform/jobs/index.ts";
import { createLogger } from "../platform/logger/index.ts";

// Тесты на реальном Postgres: каждый прогон создаёт свою БД рядом с TEST_DATABASE_URL и удаляет её.
const baseUrl = process.env.TEST_DATABASE_URL ?? "postgres://studhub:change-me-local@localhost:5432/studhub_test";
const stem = new URL(baseUrl).pathname.replace(/^\//, "").replace(/_test$/, "");
const database = `${stem}_jobsunit_${randomBytes(6).toString("hex")}_test`;

function urlFor(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function query(name: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

const logger = createLogger({
  level: "silent",
  destination: new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
});

const noop = async () => {};

describe("pg-boss на реальной БД", () => {
  beforeAll(async () => {
    await query("postgres", `CREATE DATABASE ${database}`);
  });
  afterAll(async () => {
    await query("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  it("при запуске снимает расписания задач, которых нет в коде", async () => {
    const before = createJobs({ databaseUrl: urlFor(database), logger });
    before.define({ name: "demo.old-cron", schedule: "0 3 * * *", handler: noop });
    before.define({ name: "demo.kept", schedule: "*/5 * * * *", handler: noop });
    before.define({ name: "demo.turned-event", schedule: "0 4 * * *", handler: noop });
    await before.start();
    await before.stop();
    expect(await query(database, "SELECT name FROM pgboss.schedule ORDER BY name")).toEqual([
      { name: "demo.kept" },
      { name: "demo.old-cron" },
      { name: "demo.turned-event" },
    ]);

    // Новая версия кода: demo.old-cron удалена, demo.turned-event стала задачей по событию.
    const after = createJobs({ databaseUrl: urlFor(database), logger });
    after.define({ name: "demo.kept", schedule: "*/5 * * * *", handler: noop });
    after.define({ name: "demo.turned-event", handler: noop });
    await after.start();
    await after.stop();
    expect(await query(database, "SELECT name FROM pgboss.schedule ORDER BY name")).toEqual([{ name: "demo.kept" }]);
  });

  it("политика повторов из кода применяется к новой очереди и заменяет старую у существующей", async () => {
    const policy = async () =>
      (
        await query(
          database,
          "SELECT retry_limit, retry_delay, retry_backoff FROM pgboss.queue WHERE name = 'demo.policy'",
        )
      )[0];

    const first = createJobs({ databaseUrl: urlFor(database), logger });
    first.define({ name: "demo.policy", retry: { limit: 5, delaySeconds: 7, backoff: true }, handler: noop });
    await first.start();
    await first.stop();
    expect(await policy()).toEqual({ retry_limit: 5, retry_delay: 7, retry_backoff: true });

    const second = createJobs({ databaseUrl: urlFor(database), logger });
    second.define({ name: "demo.policy", retry: { limit: 1, delaySeconds: 2 }, handler: noop });
    await second.start();
    await second.stop();
    expect(await policy()).toEqual({ retry_limit: 1, retry_delay: 2, retry_backoff: false });
  });

  it("если запуск упал после старта pg-boss, экземпляр закрывается и соединений не остаётся", async () => {
    const jobs = createJobs({ databaseUrl: urlFor(database), logger });
    jobs.define({ name: "demo.bad-cron", schedule: "это не cron", handler: noop });
    await expect(jobs.start()).rejects.toThrow();
    expect(jobs.isRunning()).toBe(false);
    const connections = await query(
      "postgres",
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    expect(connections[0]?.n).toBe(0);
  });

  it("недоступная БД: запуск падает, повторный вызов возможен", async () => {
    const jobs = createJobs({ databaseUrl: "postgres://x:x@127.0.0.1:1/none", logger });
    jobs.define({ name: "demo.any", handler: noop });
    await expect(jobs.start()).rejects.toThrow();
    await expect(jobs.start()).rejects.toThrow();
    expect(jobs.isRunning()).toBe(false);
  });
});
