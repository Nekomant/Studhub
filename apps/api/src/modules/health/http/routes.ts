import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ProblemError, problemSchema } from "../../../platform/errors/problem.ts";
import type { Logger } from "../../../platform/logger/index.ts";
import { buildHealthReport } from "../domain/health.ts";

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  responses: {
    200: {
      description: "Сервис работает, БД доступна",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok"), db: z.literal("ok") }),
        },
      },
    },
    503: {
      description: "БД недоступна",
      content: { "application/problem+json": { schema: problemSchema } },
    },
  },
});

export function healthRoutes(deps: { ping: () => Promise<void>; logger: Logger }) {
  const app = new OpenAPIHono();
  app.openapi(healthRoute, async (c) => {
    try {
      await deps.ping();
    } catch (error) {
      deps.logger.warn({ err: error }, "проверка БД не прошла");
      throw new ProblemError({ status: 503, code: "db_unavailable", title: "База данных недоступна" });
    }
    return c.json(buildHealthReport(), 200);
  });
  return app;
}
