import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/index.ts";
import { type Jobs, startJobsWithRetry } from "./index.ts";

function capture() {
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
  return { logger, entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

// Заглушка с управляемым запуском: первые `failures` вызовов start падают.
function fakeJobs(failures: number): { jobs: Jobs; calls: () => number } {
  let calls = 0;
  let running = false;
  const jobs = {
    start: async () => {
      calls += 1;
      if (calls <= failures) throw new Error("БД недоступна");
      running = true;
    },
    isRunning: () => running,
  } as unknown as Jobs;
  return { jobs, calls: () => calls };
}

describe("повторный запуск pg-boss", () => {
  it("повторяет запуск с растущей паузой до потолка и останавливается после успеха", async () => {
    const { jobs, calls } = fakeJobs(4);
    const { logger, entries } = capture();
    const pauses: number[] = [];
    await startJobsWithRetry(jobs, {
      logger,
      signal: new AbortController().signal,
      initialDelayMs: 100,
      maxDelayMs: 300,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(calls()).toBe(5);
    expect(pauses).toEqual([100, 200, 300, 300]);
    expect(entries().filter((entry) => entry.msg === "pg-boss не запустился, повторю")).toHaveLength(4);
    expect(entries().find((entry) => entry.msg === "фоновые задачи запущены")).toMatchObject({
      attempt: 5,
      running: true,
    });
  });

  it("не пишет в лог текст ошибки запуска", async () => {
    const { jobs } = fakeJobs(1);
    const { logger, entries } = capture();
    await startJobsWithRetry(jobs, { logger, signal: new AbortController().signal, sleep: async () => {} });
    expect(JSON.stringify(entries())).not.toContain("БД недоступна");
    expect(entries()[0]).toMatchObject({ attempt: 1, running: false, errorType: "Error" });
  });

  it("прекращает повторы по сигналу остановки", async () => {
    const { jobs, calls } = fakeJobs(Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    await startJobsWithRetry(jobs, {
      logger: capture().logger,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(calls()).toBe(1);
    expect(jobs.isRunning()).toBe(false);
  });
});
