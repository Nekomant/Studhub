import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";

// Тест запускает `pnpm dev` (scripts/dev.mjs): API и dev-сервер SPA на свободных портах, БД отдельная.
// Тест знает приложения только по командам и HTTP (ТД §13, правило 1).
const repoRoot = resolve(import.meta.dirname, "../../..");

test.describe.configure({ mode: "serial" });

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function databaseUrl(database: string): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL не задан: нужна тестовая БД (см. .env.example, `pnpm db:up`)");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl("postgres") });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const socket = connect({ host: "localhost", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

async function waitForHealthz(webOrigin: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "нет ответа";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webOrigin}/healthz`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`pnpm dev не поднял SPA и API за 90 с (${last}). Вывод:\n${output()}`);
}

test("[SH-008 AC-1] `pnpm dev` запускает SPA и API, SPA ходит к API через прокси /api", async ({ page }) => {
  test.setTimeout(150_000);
  const apiPort = await freePort();
  const webPort = await freePort();
  const database = `studhub_e2e_dev_${randomBytes(6).toString("hex")}_test`;
  const webOrigin = `http://localhost:${webPort}`;
  await adminQuery(`CREATE DATABASE "${database}"`);

  let log = "";
  const dev = spawn("pnpm", ["dev"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      DATABASE_URL: databaseUrl(database),
      // Значения S3 фиктивные: E2E этого этапа S3 не используют.
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_REGION: "garage",
      S3_BUCKET: "studhub-files-test",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.stdout?.on("data", (chunk) => {
    log += String(chunk);
  });
  dev.stderr?.on("data", (chunk) => {
    log += String(chunk);
  });

  try {
    await waitForHealthz(webOrigin, () => log);

    // API отвечает на своём порту, значит `pnpm dev` запустил процесс API.
    const direct = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
    expect(await direct.json()).toEqual({ status: "ok", db: "ok" });

    // Dev-сервер SPA отдаёт исходники приложения (Vite), а не сборку.
    const index = await fetch(`${webOrigin}/`);
    expect(await index.text()).toContain("/src/main.tsx");

    // Прокси /api: ответ принадлежит API, а не странице SPA.
    const proxied = await fetch(`${webOrigin}/api/v1/nothing-here`);
    expect(proxied.status).toBe(404);
    expect(proxied.headers.get("content-type")).toContain("application/problem+json");
    expect(await proxied.json()).toMatchObject({ code: "not_found" });

    // Заглушка в браузере показывает статус /healthz, полученный через прокси.
    await page.goto(`${webOrigin}/today`);
    await expect(page.getByRole("status")).toContainText("Сервер доступен");
  } finally {
    dev.kill("SIGINT");
    await waitForExit(dev);
    await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }

  // Ctrl+C останавливает оба процесса: порты свободны.
  expect(await isListening(apiPort)).toBe(false);
  expect(await isListening(webPort)).toBe(false);
});
