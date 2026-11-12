import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; if?: string };
type Workflow = { jobs: { checks: { steps: Step[] } } };

describe("CI: .github/workflows/ci.yml", () => {
  const workflow = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const steps = workflow.jobs.checks.steps;

  it.each(["pnpm gen:client:check", "pnpm test:api"])("[SH-006 AC-6] в CI есть шаг `%s`", (command) => {
    const step = steps.find((candidate) => candidate.run?.trim() === command);
    expect(step, `нет шага ${command}`).toBeDefined();
    expect(step?.if).toContain("steps.install.outcome == 'success'");
  });
});
