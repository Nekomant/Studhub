import type { ApiClient } from "./api/client.ts";

// Параметры запроса статуса сервера по GET /healthz для TanStack Query. Ошибка сети и любой ответ кроме 200
// (например, 503 при недоступной БД) — ошибка запроса.
export function healthQueryOptions(api: ApiClient) {
  return {
    queryKey: ["healthz"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const { data, response } = await api.GET("/healthz", { signal });
      if (!data) throw new Error(`healthz: ответ ${response.status}`);
      return data;
    },
    retry: false as const,
  };
}
