import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { createLogger } from "../logger/index.ts";
import { createControllableClock, createSystemClock } from "./index.ts";

describe("часы сервера", () => {
  it("[SH-006 AC-4] системные часы возвращают текущее время", () => {
    const before = Date.now();
    const now = createSystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("[SH-006 AC-4] управляемые часы стоят на заданном времени и возвращаются к системному", () => {
    const clock = createControllableClock();
    clock.set(new Date("2031-02-03T04:05:06.000Z"));
    expect(clock.now().toISOString()).toBe("2031-02-03T04:05:06.000Z");
    expect(clock.now().toISOString()).toBe("2031-02-03T04:05:06.000Z");
    clock.reset();
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("[SH-006 AC-4] now() отдаёт новый объект: изменение результата не сдвигает часы", () => {
    const clock = createControllableClock(new Date("2031-02-03T04:05:06.000Z"));
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe("2031-02-03T04:05:06.000Z");
  });

  it("[SH-006 AC-4] без testClock маршрут /__test/clock не регистрируется", async () => {
    const app = createApp({ logger: createLogger({ level: "silent" }), checkDb: async () => {} });
    const response = await app.request("/__test/clock", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("[SH-006 AC-4] с testClock маршрут /__test/clock меняет часы приложения", async () => {
    const testClock = createControllableClock();
    const app = createApp({ logger: createLogger({ level: "silent" }), checkDb: async () => {}, testClock });
    const response = await app.request("/__test/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: "2031-02-03T04:05:06.000Z" }),
    });
    expect(response.status).toBe(200);
    expect(testClock.now().toISOString()).toBe("2031-02-03T04:05:06.000Z");
  });

  it("[SH-006 AC-4] код сервера берёт время из clock.now(): Date.now() и new Date() без аргументов запрещены", () => {
    const srcRoot = join(import.meta.dirname, "../..");
    const clockDir = import.meta.dirname;
    const offenders: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      if (entry.parentPath === clockDir) continue;
      const file = join(entry.parentPath, entry.name);
      if (/Date\.now\(|new Date\(\s*\)/.test(readFileSync(file, "utf8"))) offenders.push(relative(srcRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});
