import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Полную проверку AC-1 (чистый клон → `pnpm install && pnpm check`) делаем
// вручную, результат записан в заметках задачи. Этот тест следит, чтобы
// структура не разошлась с ТД §13.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const workspacePackages = {
  "apps/api": "@studhub/api",
  "apps/web": "@studhub/web",
  "apps/admin": "@studhub/admin",
  "apps/landing": "@studhub/landing",
  "packages/client-core": "@studhub/client-core",
  "packages/ui-tokens": "@studhub/ui-tokens",
  "tests/api": "@studhub/tests-api",
  "tests/e2e": "@studhub/tests-e2e",
};

describe("[SH-002 AC-1] структура репозитория по ТД §13", () => {
  it.each(Object.entries(workspacePackages))("[SH-002 AC-1] пакет %s называется %s и имеет src/", (dir, name) => {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    expect(pkg.name).toBe(name);
    expect(pkg.private).toBe(true);
    expect(existsSync(join(repoRoot, dir, "src"))).toBe(true);
  });

  it("[SH-002 AC-1] pnpm-workspace.yaml включает apps/*, packages/* и tests/*", () => {
    const workspace = read("pnpm-workspace.yaml");
    for (const glob of ["apps/*", "packages/*", "tests/*"]) {
      expect(workspace).toContain(`- ${glob}`);
    }
  });

  it.each([
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "biome.json",
    "lefthook.yml",
    "tsconfig.json",
    "tsconfig.base.json",
    "vitest.config.ts",
    ".nvmrc",
    ".editorconfig",
    "README.md",
  ])("[SH-002 AC-1] в корне есть %s", (file) => {
    expect(existsSync(join(repoRoot, file))).toBe(true);
  });

  it("[SH-002 AC-1] корневые скрипты check и test", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.check).toContain("biome ci");
    expect(pkg.scripts.check).toContain("tsc -b");
    expect(pkg.scripts.test).toContain("vitest run");
  });

  it("[SH-002 AC-1] общий tsconfig включает strict", () => {
    const base = JSON.parse(read("tsconfig.base.json"));
    expect(base.compilerOptions.strict).toBe(true);
  });

  it("[SH-002 AC-1] apps/web и tests/api ссылаются на client-core, а не на apps/api", () => {
    for (const dir of ["apps/web", "tests/api"]) {
      const pkg = JSON.parse(read(`${dir}/package.json`));
      const tsconfig = JSON.parse(read(`${dir}/tsconfig.json`));
      expect(pkg.dependencies?.["@studhub/client-core"]).toBe("workspace:*");
      expect(pkg.dependencies?.["@studhub/api"]).toBeUndefined();
      expect(tsconfig.references).toContainEqual({ path: "../../packages/client-core" });
    }
  });
});

// SH-107: статусы Backlog, Definition of Done и карточки задач.
describe("[SH-107] статусы и Definition of Done в backlog/config.yml", () => {
  const config = () =>
    YAML.parse(read("backlog/config.yml")) as {
      statuses: string[];
      definition_of_done: string[];
    };

  it("[SH-107 AC-5] статусы ровно Backlog, Ready, Merged, Done (без In Progress и Review)", () => {
    expect(config().statuses).toEqual(["Backlog", "Ready", "Merged", "Done"]);
  });

  it("[SH-107 AC-5] ни одна задача в backlog/tasks не в статусе In Progress или Review", () => {
    const dir = join(repoRoot, "backlog/tasks");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    const bad = files
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
      .filter(({ text }) => {
        const match = /^status:\s*(.+)$/m.exec(text);
        const status = (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
        return status === "In Progress" || status === "Review";
      })
      .map(({ name }) => name);
    expect(bad).toEqual([]);
  });

  it("[SH-107 AC-6] Definition of Done: нет /code-review, есть factory next, sh-reviewer и выкладка в prod", () => {
    const dod = config().definition_of_done.join("\n");
    expect(dod).not.toContain("/code-review");
    expect(dod).toMatch(/factory next/);
    expect(dod).toMatch(/sh-reviewer/);
    expect(dod).toMatch(/prod/);
  });
});

// SH-107: удаление close-task и запасной вариант factory.
describe("[SH-107] close-task и запасной вариант factory", () => {
  it("[SH-107 AC-34] pnpm close-task удалён", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["close-task"]).toBeUndefined();
    expect(existsSync(join(repoRoot, "scripts/close-task.mjs"))).toBe(false);
  });

  it("[SH-107 AC-35] pnpm factory run остаётся запасным вариантом", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.factory).toBe("node scripts/factory.mjs");
    expect(existsSync(join(repoRoot, "scripts/factory.mjs"))).toBe(true);
  });
});
