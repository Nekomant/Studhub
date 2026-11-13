import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createLogger } from "./platform/logger/index.ts";

// Раздачу SPA процессом app проверяем на временной папке со «сборкой». Образ целиком проверяет `docker run` (SH-011).
const silentLogger = () =>
  createLogger({
    level: "silent",
    destination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });

describe("раздача SPA процессом app (webRoot)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "spa-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Studhub</title>");
    writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const makeApp = (webRoot?: string) =>
    createApp({ logger: silentLogger(), checkDb: async () => {}, ...(webRoot ? { webRoot } : {}) });

  it("[SH-011 AC-1] корень и неизвестный путь без точки отдают index.html (запасной ответ для роутера SPA)", async () => {
    const app = makeApp(root);
    for (const path of ["/", "/students/42"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await response.text()).toContain("<title>Studhub</title>");
    }
  });

  it("[SH-011 AC-1] файл из assets отдаётся как есть, index.html не кэшируется, а файл с хешем кэшируется надолго", async () => {
    const app = makeApp(root);
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log(1)");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const index = await app.request("/");
    expect(index.headers.get("cache-control")).toBe("no-cache");
  });

  it("[SH-011 AC-1] API и /healthz остаются за приложением: неизвестный /api/v1/… даёт problem+json 404, /healthz отвечает", async () => {
    const app = makeApp(root);
    const missing = await app.request("/api/v1/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-011 AC-1] /api, /ical и /__test без слэша принадлежат серверу: 404 problem+json, а не index.html", async () => {
    const app = makeApp(root);
    for (const path of ["/api", "/ical", "/__test"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toMatch(/^application\/problem\+json/);
    }
  });

  it("[SH-011 AC-1] несуществующий файл с расширением даёт 404 problem+json, а не index.html", async () => {
    const response = await makeApp(root).request("/assets/missing.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });

  it("[SH-011 AC-1] без webRoot приложение SPA не раздаёт: корень отвечает 404 problem+json", async () => {
    const response = await makeApp().request("/");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });

  it("[SH-011 AC-1] путь с .. не выходит за пределы webRoot", async () => {
    const response = await makeApp(root).request("/..%2f..%2fetc/passwd");
    expect(await response.text()).not.toContain("root:");
  });
});
