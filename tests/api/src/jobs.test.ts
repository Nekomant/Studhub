import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryDatabase } from "./support/postgres.ts";
import { startTestApp, type TestApp } from "./support/test-app.ts";

// pg-boss выполняет задачи сам, по своему опросу очереди. Тест ждёт нужного состояния в БД с коротким шагом и пределом.
async function waitFor<T>(read: () => Promise<T | undefined>, what: string, limitMs = 25_000): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function post(app: TestApp, path: string, body: object = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jobRow(app: TestApp, id: string) {
  const rows = await queryDatabase(app.databaseUrl, "SELECT state, retry_count FROM pgboss.job WHERE id = $1", [id]);
  return rows[0] as { state: string; retry_count: number } | undefined;
}

describe("фоновые задачи pg-boss", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp();
    await waitFor(async () => {
      const body = (await (await app.request("/__test/jobs")).json()) as { running: boolean };
      return body.running ? true : undefined;
    }, "запуск pg-boss");
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-007 AC-1] pg-boss работает в том же процессе и хранит данные в отдельной схеме той же БД", async () => {
    const schemas = await queryDatabase(
      app.databaseUrl,
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'pgboss'",
    );
    expect(schemas).toHaveLength(1);
    const tables = await queryDatabase(
      app.databaseUrl,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name IN ('job', 'queue', 'schedule')",
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual(["job", "queue", "schedule"]);
    const foreign = await queryDatabase(
      app.databaseUrl,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('job', 'queue', 'schedule')",
    );
    expect(foreign).toEqual([]);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("[SH-007 AC-2] служебная задача heartbeat стоит в расписании раз в минуту", async () => {
    const rows = await queryDatabase(app.databaseUrl, "SELECT cron FROM pgboss.schedule WHERE name = $1", [
      "platform.heartbeat",
    ]);
    expect(rows).toEqual([{ cron: "* * * * *" }]);
  });

  it("[SH-007 AC-2] задача по событию выполняется воркером", async () => {
    const response = await post(app, "/__test/jobs/platform.heartbeat/send");
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    const row = await waitFor(async () => {
      const found = await jobRow(app, id);
      return found?.state === "completed" ? found : undefined;
    }, "выполнение heartbeat");
    expect(row.retry_count).toBe(0);
  });

  it("[SH-007 AC-3] падающая задача повторяется по политике, HTTP отвечает", async () => {
    const response = await post(app, "/__test/jobs/test.flaky/send", { data: { failTimes: 2 } });
    const { id } = (await response.json()) as { id: string };
    // Пока задача падает и ждёт повтора, API отвечает.
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const row = await waitFor(async () => {
      const found = await jobRow(app, id);
      return found?.state === "completed" ? found : undefined;
    }, "успех после двух повторов");
    expect(row.retry_count).toBe(2);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("[SH-007 AC-3] задача, которая не восстановилась, останавливается после лимита повторов", async () => {
    const response = await post(app, "/__test/jobs/test.flaky/send", { data: {} });
    const { id } = (await response.json()) as { id: string };
    const row = await waitFor(async () => {
      const found = await jobRow(app, id);
      return found?.state === "failed" ? found : undefined;
    }, "отказ после лимита повторов");
    expect(row.retry_count).toBe(2);
    const { data, response: health } = await app.client.GET("/healthz");
    expect(health.status).toBe(200);
    expect(data).toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-007 AC-4] тест выполняет задачу синхронно, не дожидаясь расписания и очереди", async () => {
    const count = async () =>
      (await queryDatabase(app.databaseUrl, "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'test.flaky'"))[0]
        ?.n;
    const before = await count();
    const response = await post(app, "/__test/jobs/platform.heartbeat/run");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "completed" });
    const failed = await post(app, "/__test/jobs/test.flaky/run", { data: {} });
    expect(await failed.json()).toEqual({ outcome: "failed", errorName: "Error" });
    // Задачу в очередь ставит только `send`: синхронный запуск строк в pgboss.job не добавляет.
    expect(await count()).toBe(before);
  });

  it("[SH-007 AC-4] неизвестная задача даёт 404 с кодом job_not_found", async () => {
    const response = await post(app, "/__test/jobs/no.such/run");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "job_not_found" });
  });
});
