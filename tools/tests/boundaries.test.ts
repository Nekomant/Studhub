import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Фикстуры в tools/boundary-fixtures/ повторяют пути репозитория, потому что
// правила границ в biome.json привязаны к путям (overrides). Обычный
// `pnpm check` фикстуры не проверяет. Тест копирует их вместе с biome.json во
// временную папку и запускает там Biome.
// Файл `*.bad.ts` нарушает ровно одно правило ТД §13, файл `*.ok.ts` не нарушает ни одного.

const repoRoot = resolve(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tools/boundary-fixtures");
const RULE = "lint/style/noRestrictedImports";

type Diagnostic = { category: string; severity: string; location: { path: string } };

let workDir: string;
let diagnostics: Diagnostic[];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(fixturesRoot, join(entry.parentPath, entry.name)))
    .sort();
}

function restrictedImports(file: string): Diagnostic[] {
  return diagnostics.filter((d) => d.category === RULE && d.location.path === file);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "boundary-fixtures-"));
  cpSync(fixturesRoot, workDir, { recursive: true });
  cpSync(join(repoRoot, "biome.json"), join(workDir, "biome.json"));

  const biomeBin = createRequire(join(repoRoot, "package.json")).resolve("@biomejs/biome/bin/biome");
  const result = spawnSync(
    process.execPath,
    [biomeBin, "lint", "--reporter=json", "--max-diagnostics=none", "--vcs-enabled=false", "."],
    { cwd: workDir, encoding: "utf8" },
  );
  if (!result.stdout) {
    throw new Error(`Biome не запустился: ${result.stderr}`);
  }
  diagnostics = JSON.parse(result.stdout).diagnostics;
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const violations: Record<string, string[]> = {
  "импорт hono, @hono/* или drizzle-orm в */domain/*": [
    "apps/api/src/modules/students/domain/hono.bad.ts",
    "apps/api/src/modules/students/domain/type-only-hono.bad.ts",
    "apps/api/src/modules/students/domain/hono-zod-openapi.bad.ts",
    "apps/api/src/modules/students/domain/drizzle.bad.ts",
    "apps/api/src/modules/students/domain/drizzle-pg-core.bad.ts",
    "apps/api/src/modules/students/domain/rules/nested-drizzle.bad.ts",
  ],
  "импорт db/ или http/ своего модуля из domain/": [
    "apps/api/src/modules/students/domain/own-db.bad.ts",
    "apps/api/src/modules/students/domain/own-http.bad.ts",
  ],
  "импорт apps/api из apps/web, packages/client-core или tests/*": [
    "apps/web/src/api-package.bad.ts",
    "apps/web/src/api-package-subpath.bad.ts",
    "apps/web/src/api-relative.bad.ts",
    "packages/client-core/src/api-relative.bad.ts",
    "packages/client-core/src/screens/api-type-only.bad.ts",
    "tests/api/src/api-package.bad.ts",
    "tests/e2e/src/api-relative.bad.ts",
  ],
  "импорт внутренностей чужого модуля в обход index.ts": [
    "apps/api/src/modules/schedule/http/other-domain.bad.ts",
    "apps/api/src/modules/schedule/http/other-http-folder.bad.ts",
    "apps/api/src/modules/schedule/db/other-db.bad.ts",
    "apps/api/src/modules/schedule/domain/rules/other-domain-deep.bad.ts",
    "apps/api/src/modules/schedule/index-reexport.bad.ts",
    "apps/api/src/platform/module-internals.bad.ts",
    "apps/api/src/app.bad.ts",
  ],
  "доступ к БД вне */db/": [
    "apps/api/src/modules/schedule/http/drizzle.bad.ts",
    "apps/api/src/modules/schedule/http/postgres-driver.bad.ts",
    "apps/api/src/modules/schedule/http/pg-driver.bad.ts",
    "apps/api/src/platform/drizzle.bad.ts",
    "apps/api/src/modules/students/domain/postgres-driver.bad.ts",
    "apps/api/src/modules/schedule/http/platform-db.bad.ts",
  ],
};

describe("[SH-002 AC-2] Biome находит нарушения границ слоёв ТД §13", () => {
  for (const [rule, files] of Object.entries(violations)) {
    describe(rule, () => {
      it.each(files)("[SH-002 AC-2] %s: ошибка noRestrictedImports", (file) => {
        expect(restrictedImports(file)).toHaveLength(1);
      });
    });
  }

  const allowed = listFiles(fixturesRoot).filter((file) => file.endsWith(".ok.ts"));

  it.each(allowed)("[SH-002 AC-2] разрешённые импорты в %s не дают ошибок", (file) => {
    expect(restrictedImports(file)).toEqual([]);
  });

  it("[SH-002 AC-2] каждая фикстура-нарушение описана в тесте", () => {
    const listed = Object.values(violations).flat().sort();
    const bad = listFiles(fixturesRoot).filter((file) => file.endsWith(".bad.ts"));
    expect(bad).toEqual(listed);
  });

  it("[SH-002 AC-2] нарушения дают ошибку, а не предупреждение", () => {
    const found = diagnostics.filter((d) => d.category === RULE);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.severity === "error")).toBe(true);
  });
});
