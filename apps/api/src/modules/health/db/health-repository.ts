import pg from "pg";
import type { Logger } from "../../../platform/logger/index.ts";

// Проверка соединения с БД. Пул маленький: проверка редкая, основной пул приложения появится с Drizzle (SH-005).
export function createHealthRepository(databaseUrl: string, logger: Logger) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000 });
  pool.on("error", (error) => {
    logger.warn({ err: error }, "ошибка простоя соединения с БД");
  });

  return {
    async ping(): Promise<void> {
      await pool.query("select 1");
    },
  };
}
