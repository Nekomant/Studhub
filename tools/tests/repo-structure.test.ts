import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Полную проверку AC-1 (чистый клон → `pnpm install && pnpm check`) делаем
// вручную, результат записан в заметках задачи. Этот тест следит, чтобы
// структура не разошлась с ТД §13.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const workspacePackages = {
  "apps/api": "@studentshub/api",
  "apps/web": "@studentshub/web",
  "apps/landing": "@studentshub/landing",
  "packages/client-core": "@studentshub/client-core",
  "packages/ui-tokens": "@studentshub/ui-tokens",
  "tests/api": "@studentshub/tests-api",
  "tests/e2e": "@studentshub/tests-e2e",
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
      expect(pkg.dependencies?.["@studentshub/client-core"]).toBe("workspace:*");
      expect(pkg.dependencies?.["@studentshub/api"]).toBeUndefined();
      expect(tsconfig.references).toContainEqual({ path: "../../packages/client-core" });
    }
  });
});
