import { type ApiClient, createApiClient } from "@studhub/client-core";
import { inject } from "vitest";
import { startAppProcess } from "./app-process.ts";
import { createDatabase, dropDatabase, newDatabaseName, urlForDatabase } from "./postgres.ts";

export type StartOptions = {
  // false: приложение запускается без APP_MODE=test, тестовых маршрутов в нём нет. По умолчанию true.
  testMode?: boolean;
  // Своя строка подключения вместо копии шаблона (например, к недоступной БД). БД при этом не создаётся и не удаляется.
  databaseUrl?: string;
};

export type TestApp = {
  baseUrl: string;
  // Адрес БД этого приложения: для проверок состояния прямым запросом.
  databaseUrl: string;
  // Клиент, сгенерированный из openapi.json.
  client: ApiClient;
  // Запрос без типов: для маршрутов вне OpenAPI (/__test/*) и для проверки заголовков.
  request: (path: string, init?: RequestInit) => Promise<Response>;
  // Устанавливает время сервера (ISO 8601) или возвращает системное время (null). Работает только в тестовом режиме.
  setClock: (now: string | Date | null) => Promise<Response>;
  // Останавливает приложение и удаляет его БД.
  stop: () => Promise<void>;
};

// Фабрика тестового приложения. Каждый вызов даёт новый процесс приложения на новой копии шаблонной БД
// со своим портом и своими часами. Обычно один вызов на файл (beforeAll). Тест, которому нужно чистое состояние,
// вызывает фабрику сам.
export async function startTestApp(options: StartOptions = {}): Promise<TestApp> {
  let ownDatabase: string | undefined;
  let databaseUrl: string;
  if (options.databaseUrl === undefined) {
    ownDatabase = newDatabaseName("app");
    await createDatabase(ownDatabase, inject("apiTemplateDatabase"));
    databaseUrl = urlForDatabase(ownDatabase);
  } else {
    databaseUrl = options.databaseUrl;
  }

  let appProcess: Awaited<ReturnType<typeof startAppProcess>>;
  try {
    appProcess = await startAppProcess({ databaseUrl, testMode: options.testMode ?? true });
  } catch (error) {
    if (ownDatabase) await dropDatabase(ownDatabase);
    throw error;
  }

  const { baseUrl } = appProcess;
  const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  return {
    baseUrl,
    databaseUrl,
    client: createApiClient(baseUrl),
    request,
    setClock: (now) =>
      request("/__test/clock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: now instanceof Date ? now.toISOString() : now }),
      }),
    stop: async () => {
      await appProcess.stop();
      if (ownDatabase) await dropDatabase(ownDatabase);
    },
  };
}
