import { OpenAPIHono, type z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { healthRoutes } from "./modules/health/index.ts";
import { ProblemError, problemResponse } from "./platform/errors/problem.ts";
import type { Logger } from "./platform/logger/index.ts";
import { securityHeaders } from "./platform/security/headers.ts";

export const API_PREFIX = "/api/v1";

export type AppDeps = {
  logger: Logger;
  // Проверка БД для /healthz. Возвращает промис, который падает, если БД недоступна.
  checkDb: () => Promise<void>;
  // Дополнительные маршруты: получают под-приложение /api/v1 (тесты и модули первой задачи).
  extraRoutes?: ((api: OpenAPIHono) => void) | undefined;
};

// Ошибка валидации: отдаём путь и текст причины, без значений полей (в них могут быть ПДн).
function validationDetails(issues: readonly z.core.$ZodIssue[]) {
  return issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(корень)", message: issue.message }));
}

// Все маршруты API отвечают ошибками в одном формате. Запросы не из OpenAPI-схем (неверный JSON и т. п.)
// тоже попадают сюда.
function createApiRouter() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problemResponse(c, {
          status: 400,
          code: "validation_failed",
          title: "Ошибка валидации запроса",
          details: validationDetails(result.error.issues),
        });
      }
      return undefined;
    },
  });
}

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.use("*", securityHeaders);

  app.onError((error, c) => {
    if (error instanceof ProblemError) {
      return problemResponse(c, {
        status: error.status,
        code: error.code,
        title: error.message,
        details: error.details,
      });
    }
    if (error instanceof HTTPException && error.status === 400) {
      return problemResponse(c, { status: 400, code: "invalid_request", title: "Некорректный запрос" });
    }
    deps.logger.error({ err: error }, "необработанная ошибка");
    return problemResponse(c, { status: 500, code: "internal_error", title: "Внутренняя ошибка сервера" });
  });

  app.notFound((c) => problemResponse(c, { status: 404, code: "not_found", title: "Маршрут не найден" }));

  // /healthz на корне: его дёргает мониторинг через Caddy (ТД §6.2, §12).
  app.route("/", healthRoutes({ ping: deps.checkDb, logger: deps.logger }));

  const api = createApiRouter();
  deps.extraRoutes?.(api);
  app.route(API_PREFIX, api);

  return app;
}
