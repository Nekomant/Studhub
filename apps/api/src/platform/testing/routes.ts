import { Hono } from "hono";
import { z } from "zod";
import type { ControllableClock } from "../clock/index.ts";
import { problemResponse } from "../errors/problem.ts";
import type { Jobs } from "../jobs/index.ts";

// Тестовые маршруты. Приложение регистрирует их только при APP_MODE=test (app.ts).
// Это обычный Hono без zod-openapi: маршруты не попадают в openapi.json и в сгенерированный клиент.

const setClockBody = z.object({ now: z.iso.datetime().nullable() });
const jobBody = z.object({ data: z.record(z.string(), z.unknown()).optional() });

export function testRoutes(deps: { clock: ControllableClock; jobs?: Jobs | undefined }) {
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

  const jobs = deps.jobs;
  if (jobs) {
    // Состояние pg-boss и счётчики задач в этом процессе: сколько раз каждая завершилась успехом и ошибкой.
    app.get("/jobs", (c) => c.json({ running: jobs.isRunning(), jobs: jobs.stats() }, 200));

    // `run` выполняет задачу синхронно, без очереди и расписания; ошибку задачи отдаёт в теле, статус 200.
    // `send` ставит задачу в очередь pg-boss: её выполнит воркер по обычной политике повторов.
    app.post("/jobs/:name/:action{run|send}", async (c) => {
      const body = jobBody.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) {
        return problemResponse(c, { status: 400, code: "validation_failed", title: "Ошибка валидации запроса" });
      }
      const name = c.req.param("name");
      if (!Object.hasOwn(jobs.stats(), name)) {
        return problemResponse(c, { status: 404, code: "job_not_found", title: "Задача не объявлена" });
      }
      if (c.req.param("action") === "run") return c.json(await jobs.runNow(name, body.data.data), 200);
      return c.json({ id: await jobs.send(name, body.data.data) }, 202);
    });
  }

  return app;
}
