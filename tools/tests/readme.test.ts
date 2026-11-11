import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Содержание README проверяет человек при ревью. Тест следит, что нужные
// разделы и команды на месте и версия Node совпадает с .nvmrc.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("[SH-002 AC-4] README и версия Node", () => {
  it("[SH-002 AC-4] .nvmrc фиксирует Node 24", () => {
    expect(read(".nvmrc").trim()).toBe("24");
  });

  it("[SH-002 AC-4] package.json требует Node 24", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.engines.node).toMatch(/^>=24\b/);
  });

  it.each(["## Установка", "## Запуск", "## Проверки"])("[SH-002 AC-4] в README есть раздел %s", (heading) => {
    expect(read("README.md")).toMatch(new RegExp(`^${heading}`, "m"));
  });

  it.each(["nvm use", "pnpm install", "pnpm check", "pnpm test"])(
    "[SH-002 AC-4] README называет команду %s",
    (command) => {
      expect(read("README.md")).toContain(command);
    },
  );
});
