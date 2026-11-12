import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryDatabase } from "./support/postgres.ts";
import { startTestApp, type TestApp } from "./support/test-app.ts";

// Файлы isolation-a и isolation-b идентичны по структуре и запускаются параллельно.
// Оба создают таблицу isolation_probe в своей БД: общая БД дала бы ошибку или чужую строку.
const MARKER = "a";
const CLOCK = "2030-01-01T10:00:00.000Z";

describe("изоляция данных между тестовыми файлами (a)", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(async () => {
    await app.stop();
  });

  it("[SH-006 AC-3] БД файла отдельная: чужие строки не видны", async () => {
    expect(app.databaseUrl).not.toBe(process.env.TEST_DATABASE_URL);
    await queryDatabase(app.databaseUrl, "CREATE TABLE isolation_probe (marker text NOT NULL)");
    await queryDatabase(app.databaseUrl, "INSERT INTO isolation_probe (marker) VALUES ($1)", [MARKER]);
    const rows = await queryDatabase(app.databaseUrl, "SELECT marker FROM isolation_probe");
    expect(rows).toEqual([{ marker: MARKER }]);
  });

  it("[SH-006 AC-3] часы файла свои: время другого файла не мешает", async () => {
    await app.setClock(CLOCK);
    const response = await app.request("/__test/clock");
    expect(await response.json()).toEqual({ now: CLOCK });
  });
});
