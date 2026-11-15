import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-107 AC-1–AC-3: классификатор режима CI (`scripts/lib/ci-mode.mjs`) и
// структура `.github/workflows/ci.yml` (лёгкий/полный режим, job-ы checks/image/deploy).
// Тесты читают YAML и проверяют структуру, а не точные имена всех шагов.

const repoRoot = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; if?: string; uses?: string; id?: string; with?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: string[]; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

// Классификатор режима: лёгкий файл — путь начинается с `docs/` (но не `docs/process.md`)
// либо с `backlog/`. Все файлы лёгкие → "light", любой другой → "full".
const classifyFiles = async (files: string[]) => {
  const module = await import("../../scripts/lib/ci-mode.mjs");
  return module.classifyFiles(files) as "light" | "full";
};

describe("ci-mode: классификатор режима по списку файлов", () => {
  it("[SH-107 AC-1] только docs/ (кроме process.md) и backlog/ → light", async () => {
    expect(await classifyFiles(["docs/foo.md", "backlog/tasks/x.md"])).toBe("light");
  });

  it("[SH-107 AC-1] подпапка docs/ и backlog/config.yml → light", async () => {
    expect(await classifyFiles(["docs/adr/001.md", "backlog/config.yml"])).toBe("light");
  });

  it("[SH-107 AC-2] docs/process.md → full", async () => {
    expect(await classifyFiles(["docs/process.md"])).toBe("full");
  });

  it("[SH-107 AC-2] apps/web/src/x.ts → full", async () => {
    expect(await classifyFiles(["apps/web/src/x.ts"])).toBe("full");
  });

  it("[SH-107 AC-2] docs/process.md вместе с лёгким файлом → full", async () => {
    expect(await classifyFiles(["docs/process.md", "docs/foo.md"])).toBe("full");
  });

  it("[SH-107 AC-2] файл в новой папке верхнего уровня → full", async () => {
    expect(await classifyFiles(["foo/bar.md"])).toBe("full");
  });

  it("[SH-107 AC-2] файл в scripts/ → full", async () => {
    expect(await classifyFiles(["scripts/factory.mjs"])).toBe("full");
  });
});

describe("CI: .github/workflows/ci.yml — лёгкий и полный режимы", () => {
  const workflowText = () => readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const workflow = () => YAML.parse(workflowText()) as Workflow;

  it("[SH-107 AC-1] ci.yml определяет режим через ci-mode.mjs или classifyFiles", () => {
    expect(workflowText()).toMatch(/ci-mode\.mjs|classifyFiles/);
  });

  it("[SH-107 AC-1] job checks существует", () => {
    expect(workflow().jobs.checks).toBeDefined();
  });

  it("[SH-107 AC-1] тяжёлые шаги (test:api, test:e2e, db:check) не выполняются в лёгком режиме", () => {
    const steps = workflow().jobs.checks?.steps ?? [];
    for (const command of ["pnpm test:api", "pnpm test:e2e", "pnpm db:check"]) {
      const step = steps.find((candidate) => candidate.run?.trim() === command);
      expect(step, `нет шага ${command}`).toBeDefined();
      expect(step?.if, `шаг ${command} должен выполняться только в полном режиме`).toMatch(/full/);
    }
  });

  it("[SH-107 AC-1] в лёгком режиме запускаются проверка спецификаций и разбор документов doc.mjs", () => {
    const text = workflowText();
    expect(text).toMatch(/check-spec\.mjs --changed|spec:check --changed/);
    expect(text).toContain("doc.mjs");
  });

  it("[SH-107 AC-3] job image — только полный режим", () => {
    expect(workflow().jobs.image?.if, "image должен выполняться только в полном режиме").toMatch(/full/);
  });

  it("[SH-107 AC-3] job deploy — только полный режим и только push в main", () => {
    const deploy = workflow().jobs.deploy;
    expect(deploy?.if, "deploy должен выполняться только в полном режиме").toMatch(/full/);
    expect(deploy?.if, "deploy должен идти только по push в main").toMatch(/push|refs\/heads\/main/);
  });
});
