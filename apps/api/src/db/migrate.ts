import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// Папка с SQL-миграциями: apps/api/drizzle (ТД §13).
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// Применяет миграции, которые ещё не записаны в журнал drizzle. Повторный запуск ничего не меняет.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
