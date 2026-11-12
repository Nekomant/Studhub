import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./support/test-app.ts";

describe("POST /__test/clock в тестовом режиме", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-006 AC-4] тест устанавливает текущее время сервера", async () => {
    const response = await app.setClock("2031-02-03T04:05:06.000Z");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ now: "2031-02-03T04:05:06.000Z" });
    const current = await app.request("/__test/clock");
    expect(await current.json()).toEqual({ now: "2031-02-03T04:05:06.000Z" });
  });

  it("[SH-006 AC-4] время стоит на месте, пока тест не изменит его", async () => {
    await app.setClock("2031-02-03T04:05:06.000Z");
    const first = await (await app.request("/__test/clock")).json();
    const second = await (await app.request("/__test/clock")).json();
    expect(second).toEqual(first);
  });

  it("[SH-006 AC-4] now: null возвращает системное время", async () => {
    await app.setClock("2031-02-03T04:05:06.000Z");
    const response = await app.request("/__test/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: null }),
    });
    expect(response.status).toBe(200);
    const { now } = (await response.json()) as { now: string };
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(60_000);
  });

  it("[SH-006 AC-4] неверное время даёт 400 problem+json", async () => {
    const response = await app.request("/__test/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: "вчера" }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "validation_failed" }));
  });
});

describe("POST /__test/clock без тестового режима", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({ testMode: false });
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-006 AC-4] маршрут управления временем не зарегистрирован", async () => {
    const response = await app.setClock("2031-02-03T04:05:06.000Z");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "not_found" }));
    expect((await app.request("/__test/clock")).status).toBe(404);
  });
});
