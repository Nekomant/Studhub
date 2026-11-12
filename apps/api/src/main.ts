import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { createHealthRepository } from "./modules/health/index.ts";
import { createControllableClock } from "./platform/clock/index.ts";
import { runStartupConfigCheck } from "./platform/config/index.ts";
import { heartbeatJob } from "./platform/jobs/heartbeat.ts";
import { createJobs } from "./platform/jobs/index.ts";
import { createLogger } from "./platform/logger/index.ts";
import { defineTestJobs } from "./platform/testing/jobs.ts";

// Точка входа: проверяем окружение, поднимаем HTTP-сервер и фоновые задачи pg-boss в одном процессе.
const config = runStartupConfigCheck(process.env, { log: console.error, exit: (code) => process.exit(code) });
// `migrate` применяет миграции и завершает процесс: так их запускает CD (ТД §12).
if (config && process.argv[2] === "migrate") {
  try {
    await runMigrations(config.DATABASE_URL);
  } catch (error) {
    console.error("Миграции не применились:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
  console.log("Миграции применены");
  process.exit(0);
}

// PORT нужен только серверу: миграции его не читают, поэтому проверяем его после ветки migrate.
// PORT читаем отдельно от схемы конфигурации: это порт процесса, не настройка приложения. По умолчанию 3000.
const port = Number(process.env.PORT ?? 3000);
if (config && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  console.error("Неверная конфигурация окружения:\n- PORT: задан неверно");
  process.exit(1);
}

if (config) {
  const logger = createLogger({ level: config.NODE_ENV === "production" ? "info" : "debug" });
  const health = createHealthRepository(config.DATABASE_URL, logger);
  // В тестовом режиме часы управляются командой POST /__test/clock, иначе приложение берёт системные.
  const testClock = config.APP_MODE === "test" ? createControllableClock() : undefined;
  const jobs = createJobs({ databaseUrl: config.DATABASE_URL, logger });
  jobs.define(heartbeatJob);
  if (config.APP_MODE === "test") defineTestJobs(jobs);
  const app = createApp({ logger, checkDb: () => health.ping(), testClock, jobs });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "API запущен");
  });

  // Ошибка запуска pg-boss не останавливает HTTP: /healthz покажет недоступную БД, а ошибка попадёт в лог.
  jobs.start().then(
    () => logger.info("фоновые задачи запущены"),
    (error: unknown) =>
      logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "pg-boss не запустился"),
  );

  // Остановка: перестаём принимать запросы, даём активным задачам завершиться, закрываем соединения.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    jobs
      .stop()
      .catch(() => logger.error("pg-boss не остановился штатно"))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
