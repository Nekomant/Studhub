// Схема модуля здоровья. Таблиц пока нет: проверка БД только выполняет `select 1`.
// Файл нужен, чтобы drizzle-kit находил схемы модулей (drizzle.config.ts).
export {};
import { pgTable, text } from "drizzle-orm/pg-core";
export const tmpBroken = pgTable("tmp_broken", { id: text("id").primaryKey() });
