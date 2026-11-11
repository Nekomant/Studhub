import { createApp } from "./app.ts";
import { createLogger } from "./platform/logger/index.ts";

export type OpenApiDocument = { openapi: string; paths: Record<string, unknown>; [key: string]: unknown };

// Документ OpenAPI 3.1 строится из zod-схем маршрутов (ТД §6.1). Клиент в client-core генерируется из него.
// Здесь нет подключения к БД: для описания маршрутов проверка не вызывается.
export function buildOpenApiDocument(): OpenApiDocument {
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    checkDb: async () => {},
  });
  const document = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "StudentsHub API", version: "0.1.0" },
  });
  // JSON-копия: документ совпадает с тем, что попадает в файл, и не содержит классов.
  return JSON.parse(JSON.stringify(document)) as OpenApiDocument;
}
