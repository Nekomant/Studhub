import { describe, expect, it } from "vitest";
import { createApiClient } from "./api/client.ts";
import { healthQueryOptions } from "./health.ts";

function clientWith(respond: () => Response) {
  return createApiClient("http://api.test", { fetch: async () => respond() });
}

function run(client: ReturnType<typeof createApiClient>) {
  const options = healthQueryOptions(client);
  const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>;
  return queryFn({ signal: new AbortController().signal });
}

describe("[SH-008 AC-1] запрос статуса /healthz", () => {
  it("[SH-008 AC-1] возвращает тело ответа сервера", async () => {
    const client = clientWith(() => Response.json({ status: "ok", db: "ok" }));
    await expect(run(client)).resolves.toEqual({ status: "ok", db: "ok" });
  });

  it("[SH-008 AC-1] при ответе 503 падает с ошибкой", async () => {
    const problem = { type: "about:blank", title: "БД недоступна", status: 503, code: "db_unavailable" };
    const client = clientWith(
      () =>
        new Response(JSON.stringify(problem), {
          status: 503,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    await expect(run(client)).rejects.toThrow();
  });
});
