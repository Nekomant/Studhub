import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/index.ts";
import { heartbeatJob } from "./heartbeat.ts";
import { createJobs, type JobDefinition } from "./index.ts";

// Юнит-тесты не открывают соединений с БД: `start` проверяют тесты API (tests/api/src/jobs.test.ts).
function captureLogs() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    destination: new Writable({
      write(chunk, _encoding, callback) {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        callback();
      },
    }),
  });
  return { logger, lines, entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

function makeJobs() {
  const logs = captureLogs();
  return {
    jobs: createJobs({ databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused", logger: logs.logger }),
    logs,
  };
}

const PERSONAL = "Иванов Иван +79990001122";

describe("объявление задач", () => {
  it("[SH-007 AC-2] модуль объявляет периодическую задачу и задачу по событию", () => {
    const { jobs } = makeJobs();
    jobs.define(heartbeatJob);
    jobs.define({ name: "demo.on-event", handler: async () => {} });
    expect(Object.keys(jobs.stats())).toEqual(["platform.heartbeat", "demo.on-event"]);
  });

  it("[SH-007 AC-2] служебная задача-пример запускается раз в минуту", () => {
    expect(heartbeatJob.name).toBe("platform.heartbeat");
    expect(heartbeatJob.schedule).toBe("* * * * *");
  });

  it("[SH-007 AC-2] повторное имя и недопустимое имя отклоняются", () => {
    const { jobs } = makeJobs();
    jobs.define({ name: "demo.once", handler: async () => {} });
    expect(() => jobs.define({ name: "demo.once", handler: async () => {} })).toThrow(/уже объявлена/);
    expect(() => jobs.define({ name: "bad name!", handler: async () => {} })).toThrow(/Недопустимое имя/);
  });
});

describe("синхронный запуск", () => {
  it("[SH-007 AC-4] runNow выполняет обработчик с данными и возвращает результат без очереди", async () => {
    const { jobs } = makeJobs();
    const seen: unknown[] = [];
    jobs.define<{ value: number }>({
      name: "demo.sum",
      handler: async (data) => {
        seen.push(data.value);
      },
    });
    const result = await jobs.runNow("demo.sum", { value: 7 });
    expect(result).toEqual({ outcome: "completed" });
    expect(seen).toEqual([7]);
    expect(jobs.stats()["demo.sum"]).toEqual({ succeeded: 1, failed: 0 });
  });

  it("[SH-007 AC-4] runNow возвращает ошибку задачи, а не бросает её", async () => {
    const { jobs } = makeJobs();
    jobs.define({
      name: "demo.fail",
      handler: async () => {
        throw new TypeError("сбой");
      },
    });
    expect(await jobs.runNow("demo.fail")).toEqual({ outcome: "failed", errorName: "TypeError" });
    expect(jobs.stats()["demo.fail"]).toEqual({ succeeded: 0, failed: 1 });
  });

  it("[SH-007 AC-4] runNow неизвестной задачи падает с понятной ошибкой", async () => {
    const { jobs } = makeJobs();
    await expect(jobs.runNow("demo.missing")).rejects.toThrow(/не объявлена/);
  });

  it("[SH-007 AC-4] heartbeat выполняется синхронно", async () => {
    const { jobs, logs } = makeJobs();
    jobs.define(heartbeatJob);
    expect(await jobs.runNow("platform.heartbeat")).toEqual({ outcome: "completed" });
    expect(logs.entries().some((entry) => entry.job === "platform.heartbeat")).toBe(true);
  });
});

describe("ошибки задач", () => {
  const failing: JobDefinition<{ phone: string }> = {
    name: "demo.pii",
    retry: { limit: 2, delaySeconds: 1 },
    handler: async (data) => {
      throw Object.assign(new Error(`${PERSONAL} ${data.phone}`), { code: "E_DEMO" });
    },
  };

  it("[SH-007 AC-3] лог ошибки содержит задачу, попытку и тип ошибки, но не ПДн", async () => {
    const { jobs, logs } = makeJobs();
    jobs.define(failing);
    await jobs.runNow("demo.pii", { phone: "+79991112233" });
    const entry = logs.entries().find((item) => item.msg === "задача завершилась ошибкой");
    expect(entry).toMatchObject({ job: "demo.pii", attempt: 1, errorName: "Error", errorCode: "E_DEMO" });
    const text = logs.lines.join("\n");
    expect(text).not.toContain("Иванов");
    expect(text).not.toContain("+7999");
  });

  it("[SH-007 AC-3] лог показывает, будет ли повтор по политике", async () => {
    const { jobs, logs } = makeJobs();
    jobs.define({ ...failing, retry: { limit: 0, delaySeconds: 1 } });
    await jobs.runNow("demo.pii", { phone: "+79991112233" });
    expect(logs.entries().find((item) => item.msg === "задача завершилась ошибкой")).toMatchObject({
      willRetry: false,
    });

    const second = makeJobs();
    second.jobs.define(failing);
    await second.jobs.runNow("demo.pii", { phone: "+79991112233" });
    expect(second.logs.entries().find((item) => item.msg === "задача завершилась ошибкой")).toMatchObject({
      willRetry: true,
    });
  });
});
