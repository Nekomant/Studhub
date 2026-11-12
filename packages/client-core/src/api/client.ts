import createClient from "openapi-fetch";
import type { paths } from "./schema.ts";

// Типизированный клиент API: единственный способ клиента и API-тестов говорить с сервером (ТД §1, §2.2).
// `baseUrl` — адрес сервера без `/api/v1`: пути с префиксом уже есть в схеме.
export function createApiClient(baseUrl: string, options: { fetch?: typeof fetch } = {}) {
  return createClient<paths>({ baseUrl, ...options });
}

export type ApiClient = ReturnType<typeof createApiClient>;
