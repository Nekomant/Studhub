import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, string> };
type Workflow = { jobs: { checks: { steps: Step[] } } };

describe("CI: .github/workflows/ci.yml", () => {
  const workflow = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const steps = workflow.jobs.checks.steps;

  it.each(["pnpm gen:client:check", "pnpm test:api"])("[SH-006 AC-6] в CI есть шаг `%s`", (command) => {
    const step = steps.find((candidate) => candidate.run?.trim() === command);
    expect(step, `нет шага ${command}`).toBeDefined();
    expect(step?.if).toContain("steps.install.outcome == 'success'");
  });

  it("[SH-008 AC-6] в CI есть шаг `pnpm test:e2e` после установки зависимостей", () => {
    const step = steps.find((candidate) => candidate.run?.trim() === "pnpm test:e2e");
    expect(step, "нет шага pnpm test:e2e").toBeDefined();
    expect(step?.if).toContain("steps.install.outcome == 'success'");
  });

  it("[SH-008 AC-6] браузеры Playwright кэшируются по lockfile и ставятся после восстановления кэша", () => {
    const cacheAt = steps.findIndex((candidate) => candidate.uses?.startsWith("actions/cache@"));
    const cache = steps[cacheAt];
    expect(cache, "нет шага actions/cache").toBeDefined();
    expect(cache?.with?.path).toContain("ms-playwright");
    expect(cache?.with?.key).toContain("hashFiles('pnpm-lock.yaml')");

    const installAt = steps.findIndex((candidate) => candidate.run?.includes("playwright install"));
    const e2eAt = steps.findIndex((candidate) => candidate.run?.trim() === "pnpm test:e2e");
    expect(installAt).toBeGreaterThan(cacheAt);
    expect(e2eAt).toBeGreaterThan(installAt);
  });
});

describe("[SH-008 AC-4] команда pnpm test:e2e", () => {
  const readJson = (path: string) =>
    JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as { scripts: Record<string, string> };

  it("[SH-008 AC-4] сначала собирает SPA, потом запускает E2E-пакет", () => {
    const script = readJson("package.json").scripts["test:e2e"] ?? "";
    expect(script).toContain("@studhub/web build");
    expect(script).toContain("@studhub/tests-e2e test");
    expect(script.indexOf("@studhub/web build")).toBeLessThan(script.indexOf("@studhub/tests-e2e test"));
  });

  it("[SH-008 AC-4] E2E-пакет запускает Playwright", () => {
    expect(readJson("tests/e2e/package.json").scripts.test).toBe("playwright test");
  });
});
