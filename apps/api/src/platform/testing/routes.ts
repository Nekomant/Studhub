import { Hono } from "hono";
import { z } from "zod";
import type { ControllableClock } from "../clock/index.ts";
import { problemResponse } from "../errors/problem.ts";

// Тестовые маршруты. Приложение регистрирует их только при APP_MODE=test (app.ts).
// Это обычный Hono без zod-openapi: маршруты не попадают в openapi.json и в сгенерированный клиент.

const setClockBody = z.object({ now: z.iso.datetime().nullable() });

export function testRoutes(deps: { clock: ControllableClock }) {
  const app = new Hono();

  // Возвращает текущее время сервера.
  app.get("/clock", (c) => c.json({ now: deps.clock.now().toISOString() }, 200));

  // `{ now: "<ISO 8601 UTC>" }` останавливает часы на этом времени, `{ now: null }` возвращает системное время.
  app.post("/clock", async (c) => {
    const body = setClockBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return problemResponse(c, { status: 400, code: "validation_failed", title: "Ошибка валидации запроса" });
    }
    if (body.data.now === null) deps.clock.reset();
    else deps.clock.set(new Date(body.data.now));
    return c.json({ now: deps.clock.now().toISOString() }, 200);
  });

  return app;
}
