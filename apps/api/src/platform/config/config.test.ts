import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema, formatConfigIssues, loadConfig, runStartupConfigCheck } from "./index.ts";

const repoRoot = resolve(import.meta.dirname, "../../../../..");

const validEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://studentshub:change-me-local@localhost:5432/studentshub",
  TEST_DATABASE_URL: "postgres://studentshub:change-me-local@localhost:5432/studentshub_test",
  S3_ENDPOINT: "http://localhost:3900",
  S3_REGION: "garage",
  S3_BUCKET: "studentshub-files",
  S3_ACCESS_KEY_ID: "local-access-key",
  S3_SECRET_ACCESS_KEY: "local-secret-key",
};

describe("конфигурация окружения", () => {
  it("[SH-003 AC-2] при полном наборе переменных возвращает разобранную конфигурацию", () => {
    const config = loadConfig(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.S3_BUCKET).toBe("studentshub-files");
    expect(config.NODE_ENV).toBe("development");
  });

  it("[SH-003 AC-2] отсутствующие обязательные переменные перечислены по имени", () => {
    const { DATABASE_URL: _omit, S3_BUCKET: _omit2, ...rest } = validEnv;
    const result = configSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (result.success) return;
    const names = result.error.issues.map((issue) => String(issue.path[0]));
    expect(names).toEqual(expect.arrayContaining(["DATABASE_URL", "S3_BUCKET"]));
  });

  it("[SH-003 AC-2] неверный формат DATABASE_URL даёт ошибку с именем переменной", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "mysql://localhost/x" })).toThrow(/DATABASE_URL/);
  });

  it("[SH-003 AC-2] неверный S3_ENDPOINT и неизвестный NODE_ENV дают ошибку", () => {
    expect(() => loadConfig({ ...validEnv, S3_ENDPOINT: "не адрес" })).toThrow(/S3_ENDPOINT/);
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "staging-ish" })).toThrow(/NODE_ENV/);
  });

  it("[SH-003 AC-2] пустой секрет считается отсутствующим и не попадает в текст ошибки", () => {
    const result = configSchema.safeParse({ ...validEnv, S3_SECRET_ACCESS_KEY: "" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = formatConfigIssues(result.error.issues);
    expect(text).toContain("S3_SECRET_ACCESS_KEY");
    expect(text).not.toContain("local-secret-key");
  });

  it("[SH-003 AC-2] список проблем: одна строка на переменную", () => {
    const result = configSchema.safeParse({ DATABASE_URL: "bad", S3_ENDPOINT: "bad" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const lines = formatConfigIssues(result.error.issues).split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((line) => line.startsWith("- "))).toBe(true);
  });

  it("[SH-003 AC-2] при старте с ошибкой печатает список и завершает процесс с кодом 1", () => {
    const log = vi.fn();
    const exit = vi.fn();
    runStartupConfigCheck({ DATABASE_URL: "bad" }, { log, exit });
    expect(exit).toHaveBeenCalledWith(1);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("DATABASE_URL");
  });

  it("[SH-003 AC-2] при полной конфигурации старт не завершает процесс", () => {
    const log = vi.fn();
    const exit = vi.fn();
    runStartupConfigCheck(validEnv, { log, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("[SH-003 AC-3] .env.example содержит каждую переменную схемы с комментарием и без секретов", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const lines = example.split("\n");
    for (const key of Object.keys(configSchema.shape)) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      expect(index, `нет переменной ${key}`).toBeGreaterThanOrEqual(0);
      const previous = lines[index - 1] ?? "";
      expect(previous.startsWith("#"), `нет комментария над ${key}`).toBe(true);
    }
    expect(example).not.toMatch(/live_|sk_live|AKIA[0-9A-Z]{16}/);
  });
});
