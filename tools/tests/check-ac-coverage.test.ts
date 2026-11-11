import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-009: скрипт `scripts/check-ac-coverage.mjs`.
// Каждый тест собирает во временной папке свой репозиторий: задачи в backlog/tasks и файлы тестов.
// ID задач в фикстурах из диапазона SH-9xx, чтобы метки в этом файле не совпали с настоящими задачами.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/check-ac-coverage.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "check-ac-coverage-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

type FixtureTask = {
  id: string;
  status: string;
  criteria: string[];
  // Строки таблицы «План тестов»: [AC, уровень]. Без поля таблицы в задаче нет.
  plan?: [string, string][];
};

function taskFile(task: FixtureTask): string {
  const plan = task.plan
    ? [
        "## План тестов",
        "| AC | Уровень | Проверка |",
        "|---|---|---|",
        ...task.plan.map(([ac, level]) => `| ${ac} | ${level} | что-то проверяем |`),
        "",
      ].join("\n")
    : "";
  const criteria = task.criteria.map((text, i) => `- [ ] #${i + 1} ${text}`).join("\n");
  return `---
id: ${task.id}
title: Задача ${task.id}
status: ${task.status}
assignee: []
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
Что-то сделать.

${plan}
## Не входит
Остальное.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
${criteria}
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Каждый критерий приёмки покрыт тестом
<!-- DOD:END -->
`;
}

let counter = 0;
function setup(tasks: FixtureTask[], files: Record<string, string>) {
  counter += 1;
  const root = join(workDir, `repo-${counter}`);
  for (const task of tasks) {
    const path = join(root, "backlog/tasks", `${task.id.toLowerCase()} - Задача.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, taskFile(task));
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function run(root: string) {
  const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const testFile = (...labels: string[]) => labels.map((label) => `it("${label} проверка", () => {});`).join("\n");

describe("[SH-009 AC-2] scripts/check-ac-coverage", () => {
  it("[SH-009 AC-2] все критерии с метками: код 0", () => {
    const root = setup([{ id: "SH-901", status: "Done", criteria: ["первый", "второй"] }], {
      "apps/api/src/a.test.ts": testFile("[SH-901 AC-1]", "[SH-901 AC-2]"),
    });
    const result = run(root);
    expect(result.output).not.toContain("SH-901 AC-");
    expect(result.status).toBe(0);
  });

  it("[SH-009 AC-2] критерий без метки: код 1, в выводе ID и текст критерия", () => {
    const root = setup(
      [
        { id: "SH-902", status: "Review", criteria: ["есть метка", "нет метки у этого критерия"] },
        { id: "SH-903", status: "Done", criteria: ["тоже без метки"] },
      ],
      { "tests/api/src/b.test.ts": testFile("[SH-902 AC-1]") },
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-902 AC-2");
    expect(result.output).toContain("нет метки у этого критерия");
    expect(result.output).toContain("SH-903 AC-1");
    expect(result.output).not.toContain("SH-902 AC-1");
  });

  it("[SH-009 AC-2] проверяются только задачи в Review и Done", () => {
    const root = setup(
      [
        { id: "SH-904", status: "In Progress", criteria: ["без метки"] },
        { id: "SH-905", status: "Ready", criteria: ["без метки"] },
        { id: "SH-906", status: "Backlog", criteria: ["без метки"] },
      ],
      {},
    );
    const result = run(root);
    expect(result.output).not.toMatch(/SH-90[456]/);
    expect(result.status).toBe(0);
  });

  it("[SH-009 AC-2] метка на несколько критериев «[SH-NNN AC-1, AC-3]» покрывает каждый", () => {
    const root = setup([{ id: "SH-907", status: "Done", criteria: ["a", "b", "c"] }], {
      "packages/client-core/src/c.test.ts": testFile("[SH-907 AC-1, AC-3]", "[SH-907 AC-2]"),
    });
    expect(run(root).status).toBe(0);
  });

  it("[SH-009 AC-2] метка считается только в файлах тестов: не в коде, не в node_modules и не в документах", () => {
    const root = setup([{ id: "SH-908", status: "Done", criteria: ["a", "b", "c", "d"] }], {
      "apps/api/src/code.ts": "// [SH-908 AC-1]",
      "node_modules/pkg/x.test.ts": testFile("[SH-908 AC-2]"),
      "docs/process.md": "[SH-908 AC-3]",
      "tests/e2e/src/d.spec.ts": testFile("[SH-908 AC-4]"),
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-908 AC-1");
    expect(result.output).toContain("SH-908 AC-2");
    expect(result.output).toContain("SH-908 AC-3");
    expect(result.output).not.toContain("SH-908 AC-4");
  });

  it("[SH-009 AC-2] уровни «Ручная», «Ревью», «Скрипт» в плане тестов не требуют метки и печатаются как пропущенные", () => {
    const root = setup(
      [
        {
          id: "SH-909",
          status: "Done",
          criteria: ["юнит", "ручная", "ревью", "скрипт", "ручная проверка владельцем"],
          plan: [
            ["1", "Unit (Vitest)"],
            ["2", "Ручная"],
            ["3", "Ревью"],
            ["4", "Скрипт"],
            ["5", "Ручная проверка владельцем"],
          ],
        },
      ],
      { "tools/tests/e.test.ts": testFile("[SH-909 AC-1]") },
    );
    const result = run(root);
    expect(result.status).toBe(0);
    for (const ac of ["AC-2", "AC-3", "AC-4", "AC-5"]) expect(result.output).toMatch(new RegExp(`SH-909.*${ac}`));
    expect(result.output).toContain("Ручная");
    expect(result.output).toContain("Ревью");
    expect(result.output).toContain("Скрипт");
    expect(result.output).not.toContain("AC-1");
  });

  it("[SH-009 AC-2] уровни Юнит, Unit, API, E2E и неизвестные требуют метку", () => {
    const root = setup(
      [
        {
          id: "SH-910",
          status: "Done",
          criteria: ["юнит", "unit", "api", "e2e", "фикстуры"],
          plan: [
            ["1", "Юнит"],
            ["2", "Unit (Vitest)"],
            ["3", "API"],
            ["4", "E2E"],
            ["5", "Фикстуры"],
          ],
        },
      ],
      {},
    );
    const result = run(root);
    expect(result.status).toBe(1);
    for (const ac of ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"]) expect(result.output).toContain(`SH-910 ${ac}`);
  });

  it("[SH-009 AC-2] диапазоны «1–3» и «4-5» в плане тестов", () => {
    const root = setup(
      [
        {
          id: "SH-911",
          status: "Done",
          criteria: ["a", "b", "c", "d", "e", "f"],
          plan: [
            ["1–3", "Ревью"],
            ["4-5", "Ручная"],
            ["6", "API"],
          ],
        },
      ],
      {},
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-911 AC-6");
    for (const ac of ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"]) expect(result.output).not.toContain(`SH-911 ${ac}:`);
  });

  it("[SH-009 AC-2] критерий, которого нет в таблице, и критерий с ручной и тестовой строкой требуют метку", () => {
    const root = setup(
      [
        {
          id: "SH-912",
          status: "Done",
          criteria: ["ручная и API", "нет в таблице"],
          plan: [
            ["1", "Ручная"],
            ["1", "API"],
          ],
        },
      ],
      {},
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-912 AC-1:");
    expect(result.output).toContain("SH-912 AC-2:");
  });
});
