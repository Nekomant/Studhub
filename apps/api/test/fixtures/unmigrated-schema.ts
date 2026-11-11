// Фикстура для проверки db:check: таблицы нет ни в одной миграции, поэтому генерация должна создать новый файл.
import { pgTable, uuid } from "drizzle-orm/pg-core";

export const unmigratedProbe = pgTable("unmigrated_probe", {
  id: uuid("id").primaryKey(),
});
