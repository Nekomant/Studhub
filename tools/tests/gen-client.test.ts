import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Генератор клиента OpenAPI: packages/client-core/scripts/gen-client.mjs.
const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "packages/client-core/scripts/gen-client.mjs");
const specPath = join(repoRoot, "apps/api/openapi.json");

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "gen-client-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("клиент OpenAPI в client-core", () => {
  it("[SH-006 AC-1] корневой скрипт gen:client запускает генератор, gen:client:check запускает проверку", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["gen:client"]).toContain("gen-client.mjs");
    expect(pkg.scripts["gen:client:check"]).toContain("gen-client.mjs");
    expect(pkg.scripts["gen:client:check"]).toContain("--check");
  });

  it("[SH-006 AC-1] закоммиченный клиент совпадает с генерацией из openapi.json", () => {
    const result = run(["--check"]);
    expect(result.output).toBe("Клиент OpenAPI актуален\n");
    expect(result.status).toBe(0);
  });

  it("[SH-006 AC-1] генерация создаёт типы маршрутов из спецификации", () => {
    const out = join(workDir, "schema.ts");
    expect(run(["--out", out]).status).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("export interface paths");
    expect(text).toContain('"/healthz"');
  });

  it("[SH-006 AC-1] проверка падает, если openapi.json изменён без перегенерации", () => {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { paths: Record<string, unknown> };
    spec.paths["/added-without-generation"] = {
      get: { responses: { "200": { description: "ok" } } },
    };
    const changedSpec = join(workDir, "openapi.json");
    writeFileSync(changedSpec, JSON.stringify(spec));
    const result = run(["--check", "--spec", changedSpec]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("pnpm gen:client");
  });
});
