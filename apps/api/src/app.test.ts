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

// Маршруты из HTTP-сценариев (healthz, заголовки, 404) проверяет tests/api. Здесь остаются проверки, которым нужен код сервера:
// свои маршруты через extraRoutes.
// extraRoutes получает под-приложение /api/v1: маршруты в нём пишутся без префикса.
function makeApp(options: { extraRoutes?: (api: OpenAPIHono) => void }) {
  return createApp({ logger: silentLogger(), checkDb: async () => {}, extraRoutes: options.extraRoutes });
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

describe("ошибки API", () => {
  it("[SH-004 AC-2] ошибка валидации возвращает problem+json без значений полей", async () => {
    const route = createRoute({
      method: "post",
      path: "/_test/echo",
      request: { body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } } },
      responses: { 200: { description: "ok" } },
    });
    const app = makeApp({
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
