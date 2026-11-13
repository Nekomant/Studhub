import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Каркас apps/admin (SH-076). Поведение страницы проверяет E2E (tests/e2e/src/admin.spec.ts),
// границы импортов проверяет boundaries.test.ts. Здесь сборка, подключение к проверкам и документы.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

type Step = { name?: string; run?: string };
type Workflow = { jobs: { checks: { steps: Step[] } } };

describe("[SH-076 AC-1] сборка apps/admin", () => {
  it("[SH-076 AC-1] `pnpm --filter @studhub/admin build` завершается с кодом 0 и создаёт сборку", () => {
    // Собираем во временную папку: общий `apps/admin/dist` нужен E2E и не должен пропадать посреди прогона.
    const outDir = mkdtempSync(join(tmpdir(), "admin-build-"));

    try {
      const result = spawnSync("pnpm", ["--filter", "@studhub/admin", "build", "--outDir", outDir, "--emptyOutDir"], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(existsSync(join(outDir, "index.html"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("[SH-076 AC-4] apps/admin в pnpm check и в CI", () => {
  it("[SH-076 AC-4] корневой tsconfig.json ссылается на apps/admin, поэтому `tsc -b` проверяет типы", () => {
    const root = JSON.parse(read("tsconfig.json")) as { references: { path: string }[] };
    expect(root.references.map((reference) => reference.path)).toContain("apps/admin");
  });

  it("[SH-076 AC-4] Biome не исключает apps/admin из проверки", () => {
    const biome = JSON.parse(read("biome.json")) as { files: { includes: string[] } };
    const excluded = biome.files.includes.filter((glob) => glob.startsWith("!"));
    expect(excluded.some((glob) => glob.includes("apps/admin"))).toBe(false);
  });

  it("[SH-076 AC-4] в CI есть шаг, который собирает apps/admin", () => {
    const workflow = YAML.parse(read(".github/workflows/ci.yml")) as Workflow;
    const step = workflow.jobs.checks.steps.find((candidate) => candidate.run?.includes("@studhub/admin build"));
    expect(step, "нет шага сборки @studhub/admin").toBeDefined();
    expect(step?.run?.trim()).toBe("pnpm --filter @studhub/admin build");
  });

  it("[SH-076 AC-4] `pnpm test:e2e` собирает apps/admin до запуска E2E", () => {
    const script = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["test:e2e"] ?? "";
    expect(script).toContain("@studhub/admin build");
    expect(script.indexOf("@studhub/admin build")).toBeLessThan(script.indexOf("@studhub/tests-e2e test"));
  });
});

describe("[SH-076 AC-5] документы описывают запуск apps/admin", () => {
  it("[SH-076 AC-5] README называет команду запуска и говорит, что приложение пустое", () => {
    const readme = read("README.md");
    expect(readme).toContain("pnpm --filter @studhub/admin dev");
    expect(readme).toContain("Заглушка");
  });

  it("[SH-076 AC-5] ТД §13 называет команду запуска и говорит, что приложение пустое", () => {
    const td = read("docs/technical-design.md");
    const section = td.slice(td.indexOf("## 13. Структура репозитория"), td.indexOf("## 14."));
    expect(section).toContain("pnpm --filter @studhub/admin dev");
    expect(section).toContain("заглушка");
  });
});
