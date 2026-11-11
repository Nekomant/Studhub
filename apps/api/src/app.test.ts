import { Writable } from "node:stream";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.ts";
import { createLogger } from "./platform/logger/index.ts";

const silentLogger = () =>
  createLogger({
    level: "silent",
    destination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });

// extraRoutes получает под-приложение /api/v1: маршруты в нём пишутся без префикса.
function makeApp(options: { dbOk: boolean; extraRoutes?: (api: OpenAPIHono) => void }) {
  return createApp({
    logger: silentLogger(),
    checkDb: async () => {
      if (!options.dbOk) throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=secret");
    },
    extraRoutes: options.extraRoutes,
  });
}

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual(
    expect.objectContaining({
      type: expect.any(String),
      title: expect.any(String),
      status,
      code,
    }),
  );
  return body;
}

describe("GET /healthz", () => {
  it("[SH-004 AC-1] отвечает 200 и db: ok, когда БД доступна", async () => {
    const app = makeApp({ dbOk: true });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-004 AC-1] отвечает 503 в формате problem+json, когда БД недоступна", async () => {
    const app = makeApp({ dbOk: false });
    const response = await app.request("/healthz");
    const body = await expectProblem(response, 503, "db_unavailable");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("ошибки API", () => {
  it("[SH-004 AC-2] неизвестный маршрут возвращает problem+json с code", async () => {
    const app = makeApp({ dbOk: true });
    const response = await app.request("/api/v1/nothing-here");
    await expectProblem(response, 404, "not_found");
  });

  it("[SH-004 AC-2] ошибка валидации возвращает problem+json без значений полей", async () => {
    const route = createRoute({
      method: "post",
      path: "/_test/echo",
      request: { body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } } },
      responses: { 200: { description: "ok" } },
    });
    const app = makeApp({
      dbOk: true,
      extraRoutes: (instance) => {
        instance.openapi(route, (c) => c.json({ ok: true }, 200));
      },
    });
    const response = await app.request("/api/v1/_test/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    const body = await expectProblem(response, 400, "validation_failed");
    expect(JSON.stringify(body)).not.toContain('"name": ""');
  });

  it("[SH-004 AC-2] необработанное исключение возвращает 500 без стека и внутренних деталей", async () => {
    const app = makeApp({
      dbOk: true,
      extraRoutes: (instance) => {
        instance.get("/_test/boom", () => {
          throw new Error("internal detail: password=hunter2 at /srv/app/secret.ts:10");
        });
      },
    });
    const response = await app.request("/api/v1/_test/boom");
    const body = await expectProblem(response, 500, "internal_error");
    const text = JSON.stringify(body);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret.ts");
    expect(text).not.toContain("stack");
  });
});

describe("заголовки безопасности", () => {
  it("[SH-004 AC-5] ответ содержит CSP с default-src 'self' и frame-ancestors 'none'", async () => {
    const app = makeApp({ dbOk: true });
    const response = await app.request("/healthz");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("[SH-004 AC-5] заголовки безопасности есть и в ответах с ошибкой", async () => {
    const app = makeApp({ dbOk: true });
    const response = await app.request("/api/v1/nothing-here");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
