import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryDatabase } from "./support/postgres.ts";
import { startTestApp, type TestApp } from "./support/test-app.ts";

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual(expect.objectContaining({ type: expect.any(String), title: expect.any(String), status, code }));
  return body;
}

describe("GET /healthz", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-006 AC-2] приложение отвечает на /healthz через сгенерированный клиент", async () => {
    const { data, response } = await app.client.GET("/healthz");
    expect(response.status).toBe(200);
    expect(data).toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-006 AC-2] приложение работает на тестовой БД с применёнными миграциями", async () => {
    const extensions = await queryDatabase(
      app.databaseUrl,
      "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(extensions).toHaveLength(1);
    const ledger = await queryDatabase(app.databaseUrl, "SELECT id FROM drizzle.__drizzle_migrations");
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  it("[SH-004 AC-1] /healthz отвечает 200 и db: ok, когда БД доступна", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-004 AC-2] неизвестный маршрут возвращает problem+json с code", async () => {
    await expectProblem(await app.request("/api/v1/nothing-here"), 404, "not_found");
  });

  it("[SH-004 AC-5] ответ содержит CSP с default-src 'self' и frame-ancestors 'none'", async () => {
    const response = await app.request("/healthz");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("[SH-004 AC-5] заголовки безопасности есть и в ответах с ошибкой", async () => {
    const response = await app.request("/api/v1/nothing-here");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("GET /healthz при недоступной БД", () => {
  let app: TestApp;
  beforeAll(async () => {
    // Порт 1 никто не слушает: соединение отклоняется сразу.
    app = await startTestApp({ databaseUrl: "postgres://studhub:secret@127.0.0.1:1/missing" });
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-004 AC-1] отвечает 503 problem+json без деталей соединения", async () => {
    const body = await expectProblem(await app.request("/healthz"), 503, "db_unavailable");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
