import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

// Запуск собранного кода приложения как отдельного процесса: API-тесты знают о сервере только по HTTP.
// Путь к точке входа — это путь файла, а не импорт кода (ТД §13, правило 1).
const apiRoot = resolve(import.meta.dirname, "../../../../apps/api");

// Переменные, которых требует конфигурация приложения. Значения S3 фиктивные: API-тесты S3 не используют.
function appEnv(databaseUrl: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    APP_MODE: "",
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_REGION: "garage",
    S3_BUCKET: "studhub-files-test",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    ...extra,
  };
}

// Хвост вывода процесса: показываем его, если приложение не запустилось.
function collectTail(child: ChildProcess): () => string {
  const lines: string[] = [];
  const push = (chunk: Buffer) => {
    lines.push(...chunk.toString().split("\n").filter(Boolean));
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  return () => lines.join("\n");
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

// Применяет миграции командой `migrate`: так их применяет и CD.
export async function runMigrateCommand(databaseUrl: string): Promise<void> {
  const child = spawn(process.execPath, ["src/main.ts", "migrate"], {
    cwd: apiRoot,
    env: appEnv(databaseUrl, {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = collectTail(child);
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`миграции не применились (код ${code}):\n${tail()}`);
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

export type AppProcess = { baseUrl: string; stop: () => Promise<void> };

export async function startAppProcess(options: { databaseUrl: string; testMode: boolean }): Promise<AppProcess> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: apiRoot,
    env: appEnv(options.databaseUrl, { PORT: String(port), APP_MODE: options.testMode ? "test" : "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = collectTail(child);
  // Если процесс теста завершился аварийно, приложение не остаётся висеть.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);

  const stop = async () => {
    process.off("exit", killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await waitForExit(child);
      clearTimeout(timer);
    }
  };

  // Приложение готово, когда отвечает на HTTP любым статусом (при недоступной БД /healthz отвечает 503).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`приложение завершилось при запуске (код ${child.exitCode}):\n${tail()}`);
    }
    try {
      await fetch(`${baseUrl}/healthz`);
      return { baseUrl, stop };
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  await stop();
  throw new Error(`приложение не ответило за 30 с:\n${tail()}`);
}
