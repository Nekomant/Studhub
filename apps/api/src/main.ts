import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createHealthRepository } from "./modules/health/index.ts";
import { runStartupConfigCheck } from "./platform/config/index.ts";
import { createLogger } from "./platform/logger/index.ts";

// Точка входа: проверяем окружение, поднимаем HTTP-сервер. Фоновый воркер добавит задача pg-boss (SH-007).
const config = runStartupConfigCheck(process.env, { log: console.error, exit: (code) => process.exit(code) });
// PORT читаем отдельно от схемы конфигурации: это порт процесса, не настройка приложения. По умолчанию 3000.
const port = Number(process.env.PORT ?? 3000);
if (config && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  console.error("Неверная конфигурация окружения:\n- PORT: задан неверно");
  process.exit(1);
}

if (config) {
  const logger = createLogger({ level: config.NODE_ENV === "production" ? "info" : "debug" });
  const health = createHealthRepository(config.DATABASE_URL, logger);
  const app = createApp({ logger, checkDb: () => health.ping() });

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "API запущен");
  });
}
