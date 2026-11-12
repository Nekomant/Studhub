import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema, formatConfigIssues, loadConfig, runStartupConfigCheck } from "./index.ts";

const repoRoot = resolve(import.meta.dirname, "../../../../..");

const validEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://studhub:change-me-local@localhost:5432/studhub",
  TEST_DATABASE_URL: "postgres://studhub:change-me-local@localhost:5432/studhub_test",
  S3_ENDPOINT: "http://localhost:3900",
  S3_REGION: "garage",
  S3_BUCKET: "studhub-files",
  S3_ACCESS_KEY_ID: "local-access-key",
  S3_SECRET_ACCESS_KEY: "local-secret-key",
};

describe("конфигурация окружения", () => {
  it("[SH-003 AC-2] при полном наборе переменных возвращает разобранную конфигурацию", () => {
    const config = loadConfig(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.S3_BUCKET).toBe("studhub-files");
    expect(config.NODE_ENV).toBe("development");
  });

  it("[SH-006 AC-4] APP_MODE: test включает тестовый режим, пустое значение и отсутствие выключают, другое значение даёт ошибку", () => {
    expect(loadConfig({ ...validEnv, APP_MODE: "test" }).APP_MODE).toBe("test");
    expect(loadConfig({ ...validEnv, APP_MODE: "" }).APP_MODE).toBeUndefined();
    expect(loadConfig(validEnv).APP_MODE).toBeUndefined();
    expect(() => loadConfig({ ...validEnv, APP_MODE: "staging" })).toThrow(/APP_MODE/);
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
    const env = { ...validEnv, S3_SECRET_ACCESS_KEY: "" };
    const result = configSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = formatConfigIssues(result.error.issues, env);
    expect(text).toContain("S3_SECRET_ACCESS_KEY: не задана");
    expect(text).not.toContain("local-secret-key");
    expect(() => loadConfig({ ...validEnv, S3_BUCKET: "" })).toThrow(/S3_BUCKET: не задана/);
  });

  it("[SH-003 AC-2] список проблем: одна строка на переменную", () => {
    const env = { DATABASE_URL: "bad", S3_ENDPOINT: "bad" };
    const result = configSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (result.success) return;
    const lines = formatConfigIssues(result.error.issues, env).split("\n");
    expect(lines).toContain("- DATABASE_URL: задана неверно");
    expect(lines).toContain("- S3_BUCKET: не задана");
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
    const keys = lines.filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.split("=")[0] ?? "");
    expect(new Set(keys).size, "переменные в шаблоне повторяются").toBe(keys.length);
    const composeOnly = [
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "POSTGRES_PORT",
      "GARAGE_RPC_SECRET",
      "S3_PORT",
    ];
    const known = [...Object.keys(configSchema.shape), ...composeOnly];
    for (const key of keys) {
      expect(known, `лишняя переменная ${key}`).toContain(key);
    }
    expect(example).not.toMatch(/live_|sk_live|AKIA[0-9A-Z]{16}|-----BEGIN/);
  });
});
