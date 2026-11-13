import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import pg from "pg";

// Стек для E2E: пустая БД с миграциями, процесс API и `vite preview` собранной SPA с прокси на API.
// Playwright запускает этот скрипт как webServer и останавливает его сигналом SIGTERM. Тогда скрипт
// завершает процессы и удаляет БД. Скрипт знает приложения только по путям и HTTP (ТД §13, правило 1).
const repoRoot = resolve(import.meta.dirname, "../../../..");
const apiRoot = resolve(repoRoot, "apps/api");
const webRoot = resolve(repoRoot, "apps/web");
const previewPort = Number(process.env.E2E_PORT ?? 4173);

// Из окружения стека процессы получают только эти переменные. TEST_DATABASE_URL и прочее не передаём.
const inheritedEnv = ["PATH", "HOME", "TMPDIR", "LANG", "TZ"] as const;

function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    inheritedEnv.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL не задан: E2E нужна тестовая БД (см. .env.example, `pnpm db:up`)");
  }
  return url;
}

function withDatabase(url: string, database: string): string {
  const copy = new URL(url);
  copy.pathname = `/${database}`;
  return copy.toString();
}

// Имя БД оканчивается на _test: так `pnpm db:reset-test` и проверки безопасности узнают тестовую БД.
function newDatabaseName(): string {
  const stem = new URL(testDatabaseUrl()).pathname.replace(/^\//, "").replace(/_test$/, "");
  if (!/^[a-z0-9_]+$/.test(stem)) throw new Error(`имя БД в TEST_DATABASE_URL должно состоять из a-z, 0-9, _`);
  return `${stem}_e2e_${randomBytes(6).toString("hex")}_test`;
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase(testDatabaseUrl(), "postgres") });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

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

function apiEnv(databaseUrl: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    // Значения S3 фиктивные: E2E этого этапа S3 не используют.
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_REGION: "garage",
    S3_BUCKET: "studhub-files-test",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    ...extra,
  };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

async function runMigrations(databaseUrl: string): Promise<void> {
  const child = spawn(process.execPath, ["src/main.ts", "migrate"], {
    cwd: apiRoot,
    env: apiEnv(databaseUrl, {}),
    stdio: "inherit",
  });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`миграции не применились (код ${code})`);
}

// Приложение пишет JSON-строку «API запущен» с портом, когда начало слушать.
function waitForApi(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let buffer = "";
    child.once("exit", (code) => reject(new Error(`API завершился при запуске (код ${code})`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { msg?: string; port?: number };
          if (entry.msg === "API запущен" && entry.port === port) resolveReady();
        } catch {
          // Строка не JSON: это не лог приложения.
        }
      }
    });
  });
}

const apiStartAttempts = 3;

// Свободный порт мог занять другой процесс между проверкой и запуском API (параллельные тесты, другие сервисы).
// Тогда API завершается при запуске, и стек повторяет запуск с новым портом.
async function startApi(databaseUrl: string): Promise<{ api: ChildProcess; apiPort: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const apiPort = await freePort();
    const api = spawn(process.execPath, ["src/main.ts"], {
      cwd: apiRoot,
      env: apiEnv(databaseUrl, { PORT: String(apiPort) }),
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await waitForApi(api, apiPort);
      return { api, apiPort };
    } catch (error) {
      if (attempt >= apiStartAttempts) throw error;
      console.error(`API не запустился на порту ${apiPort}, повторяю (${attempt} из ${apiStartAttempts})`);
    }
  }
}

const children: ChildProcess[] = [];
let database: string | undefined;
let stopping = false;

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => waitForExit(child)));
    if (database) await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  }
  process.exit(code);
}

process.once("SIGTERM", () => void stop(0));
process.once("SIGINT", () => void stop(0));

try {
  database = newDatabaseName();
  await adminQuery(`CREATE DATABASE ${database}`);
  const databaseUrl = withDatabase(testDatabaseUrl(), database);
  await runMigrations(databaseUrl);

  const { api, apiPort } = await startApi(databaseUrl);
  children.push(api);

  // Собранную SPA отдаёт `vite preview`: он же проксирует /api и /healthz на API, как Caddy в prod.
  const preview = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"],
    {
      cwd: webRoot,
      env: { ...baseEnv(), API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      stdio: "inherit",
    },
  );
  children.push(preview);
  preview.once("exit", (code) => void stop(code ?? 1));
  api.once("exit", (code) => void stop(code ?? 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}
