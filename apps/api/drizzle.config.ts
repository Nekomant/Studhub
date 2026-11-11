import { defineConfig } from "drizzle-kit";

// Схемы каждого модуля лежат в modules/<модуль>/db/schema.ts (ТД §13). Миграции — SQL-файлы в drizzle/, их читаем на ревью.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
