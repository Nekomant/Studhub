import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger/index.ts";
import { gracefulShutdown } from "./shutdown.ts";

const logger = createLogger({
  level: "silent",
  destination: new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
});
const options = { logger, httpTimeoutMs: 50, jobsTimeoutMs: 50 };

describe("остановка процесса", () => {
  it("закрывает HTTP, потом задачи, и возвращает 0", async () => {
    const order: string[] = [];
    const code = await gracefulShutdown(
      {
        closeServer: (done) => {
          order.push("http");
          done();
        },
        stopJobs: async () => {
          order.push("jobs");
        },
      },
      options,
    );
    expect(code).toBe(0);
    expect(order).toEqual(["http", "jobs"]);
  });

  it("ждёт запросы в работе: задачи останавливаются после закрытия сервера", async () => {
    const order: string[] = [];
    const code = await gracefulShutdown(
      {
        closeServer: (done) =>
          setTimeout(() => {
            order.push("http");
            done();
          }, 20),
        stopJobs: async () => {
          order.push("jobs");
        },
      },
      options,
    );
    expect(code).toBe(0);
    expect(order).toEqual(["http", "jobs"]);
  });

  it("возвращает 1, если остановка задач упала", async () => {
    const code = await gracefulShutdown(
      {
        closeServer: (done) => done(),
        stopJobs: async () => {
          throw new Error("сбой");
        },
      },
      options,
    );
    expect(code).toBe(1);
  });

  it("возвращает 1, если сервер не закрылся, но всё равно останавливает задачи", async () => {
    let stopped = false;
    const code = await gracefulShutdown(
      {
        closeServer: (done) => done(new Error("закрыт")),
        stopJobs: async () => {
          stopped = true;
        },
      },
      options,
    );
    expect(code).toBe(1);
    expect(stopped).toBe(true);
  });

  it("по таймауту закрывает соединения принудительно и возвращает 1", async () => {
    let forced = false;
    const code = await gracefulShutdown(
      {
        closeServer: () => {},
        forceCloseServer: () => {
          forced = true;
        },
        stopJobs: async () => {},
      },
      options,
    );
    expect(code).toBe(1);
    expect(forced).toBe(true);
  });

  it("возвращает 1, если задачи не остановились за таймаут", async () => {
    const code = await gracefulShutdown(
      { closeServer: (done) => done(), stopJobs: () => new Promise(() => {}) },
      options,
    );
    expect(code).toBe(1);
  });
});
