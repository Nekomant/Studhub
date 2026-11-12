import type { TestProject } from "vitest/node";
import { runMigrateCommand } from "./app-process.ts";
import { createDatabase, dropDatabase, newDatabaseName, urlForDatabase } from "./postgres.ts";

declare module "vitest" {
  export interface ProvidedContext {
    // Имя шаблонной БД: пустая БД с применёнными миграциями. Тестовые файлы копируют её.
    apiTemplateDatabase: string;
  }
}

// Глобальная подготовка: один раз на прогон создаёт шаблонную БД и применяет к ней миграции.
export default async function setup(project: TestProject) {
  const template = newDatabaseName("template");
  await createDatabase(template);
  try {
    await runMigrateCommand(urlForDatabase(template));
  } catch (error) {
    await dropDatabase(template);
    throw error;
  }
  project.provide("apiTemplateDatabase", template);

  return async () => {
    await dropDatabase(template);
  };
}
