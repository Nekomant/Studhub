import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";

// Тест запускает `pnpm dev` (scripts/dev.mjs): API и dev-сервер SPA на свободных портах, БД отдельная.
// Тест знает приложения только по командам и HTTP (ТД §13, правило 1).
const repoRoot = resolve(import.meta.dirname, "../../..");
const startAttempts = 3;

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

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

type Dev = { child: ChildProcess; apiPort: number; webPort: number; webOrigin: string };

// Свободный порт мог занять другой процесс между проверкой и запуском. Тогда `pnpm dev` завершается сразу,
// и тест повторяет запуск с новыми портами. Процесс, который работает, но не отвечает, повтора не вызывает.
async function startDev(database: string): Promise<Dev> {
  for (let attempt = 1; ; attempt += 1) {
    const apiPort = await freePort();
    const webPort = await freePort();
    const webOrigin = `http://localhost:${webPort}`;
    let log = "";
    const child = spawn("pnpm", ["dev"], {
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
    child.stdout?.on("data", (chunk) => {
      log += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      log += String(chunk);
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !hasExited(child)) {
      try {
        const response = await fetch(`${webOrigin}/healthz`);
        if (response.ok) return { child, apiPort, webPort, webOrigin };
      } catch {
        // Сервер ещё не слушает порт.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }

    const exitedEarly = hasExited(child);
    if (!exitedEarly) {
      child.kill("SIGINT");
      await waitForExit(child);
    }
    if (!exitedEarly || attempt >= startAttempts) {
      throw new Error(`pnpm dev не поднял SPA и API (попытка ${attempt}). Вывод:\n${log}`);
    }
  }
}

test("[SH-008 AC-1] `pnpm dev` запускает SPA и API, SPA ходит к API через прокси /api", async ({ page }) => {
  test.setTimeout(150_000);
  const database = `studhub_e2e_dev_${randomBytes(6).toString("hex")}_test`;
  await adminQuery(`CREATE DATABASE "${database}"`);

  let dev: Dev | undefined;
  try {
    dev = await startDev(database);
    const { apiPort, webOrigin } = dev;

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
    if (dev) {
      dev.child.kill("SIGINT");
      await waitForExit(dev.child);
    }
    await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }

  // Ctrl+C останавливает оба процесса: порты свободны.
  expect(dev).toBeDefined();
  expect(await isListening(dev?.apiPort ?? 0)).toBe(false);
  expect(await isListening(dev?.webPort ?? 0)).toBe(false);
});

test("[SH-008 AC-1] `pnpm dev` выходит с кодом ошибки, если процесс остановился сам, и останавливает второй", async () => {
  test.setTimeout(60_000);
  // Порт SPA занят, WEB_PORT требует именно его (strictPort): dev-сервер завершается с ошибкой при запуске.
  const busy = createServer();
  await new Promise<void>((resolveListen) => busy.listen(0, "localhost", resolveListen));
  const address = busy.address();
  const webPort = typeof address === "object" && address ? address.port : 0;
  const apiPort = await freePort();
  let log = "";
  const child = spawn("pnpm", ["dev"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    log += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    log += String(chunk);
  });

  try {
    const code = await new Promise<number | null>((resolveExit) =>
      child.once("exit", (exitCode) => resolveExit(exitCode)),
    );
    expect(code, log).not.toBe(0);
    expect(await isListening(apiPort)).toBe(false);
  } finally {
    if (!hasExited(child)) child.kill("SIGKILL");
    await new Promise((resolveClose) => busy.close(resolveClose));
  }
});
