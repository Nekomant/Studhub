import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-089: скрипт `scripts/check-spec.mjs`.
// Каждый тест собирает во временной папке свой репозиторий с задачами в backlog/tasks и передаёт его флагом --root.
// ID задач в фикстурах из диапазона SH-9xx, чтобы они не совпали с настоящими задачами.
// AC-9 (запуск на задачах Ready из main) и просмотр шага CI проверяются вручную и в ревью:
// здесь только проверка, что команда и шаг CI есть.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/check-spec.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "check-spec-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const SECTIONS = ["Что нужно сделать", "Зачем", "Контекст", "Не входит", "Контракт", "План тестов"] as const;

type FixtureTask = {
  id: string;
  status?: string;
  milestone?: string;
  dependencies?: string[];
  criteria?: string[];
  // Строки таблицы «План тестов»: [AC, уровень]. По умолчанию уровень «Юнит» на каждый критерий.
  plan?: [string, string][];
  // Разделы, которых в описании нет, и разделы с пустым телом.
  omit?: string[];
  empty?: string[];
  // Шаги раздела «Что нужно сделать».
  steps?: string[];
  // Текст в конце раздела «Зачем».
  why?: string;
  // Текст в конце указанных разделов (подзаголовки, блоки кода).
  append?: Record<string, string>;
  // Строка поля dependencies вместо списка, например " SH-902" (скаляр) или " null".
  rawDependencies?: string;
};

function taskFile(task: FixtureTask): string {
  const criteria = task.criteria ?? ["первый", "второй"];
  const plan = task.plan ?? criteria.map((_, i): [string, string] => [String(i + 1), "Юнит"]);
  const bodies: Record<string, string> = {
    "Что нужно сделать": (task.steps ?? ["Написать код."]).map((step, i) => `${i + 1}. ${step}`).join("\n"),
    Зачем: `Нужно для дела. ${task.why ?? ""}`.trim(),
    Контекст: "- Правила: ТД §4.2",
    "Не входит": "Остальное.",
    Контракт: "Нет API и БД.",
    "План тестов": [
      "| AC | Уровень | Тест |",
      "|---|---|---|",
      ...plan.map(([ac, level]) => `| ${ac} | ${level} | тест |`),
    ].join("\n"),
  };
  const description = SECTIONS.filter((name) => !task.omit?.includes(name))
    .map(
      (name) =>
        `## ${name}\n${task.empty?.includes(name) ? "" : bodies[name]}${task.append?.[name] ? `\n${task.append[name]}` : ""}\n`,
    )
    .join("\n");
  const deps = task.dependencies?.length ? `\n${task.dependencies.map((d) => `  - ${d}`).join("\n")}` : " []";
  return `---
id: ${task.id}
title: Задача ${task.id}
status: ${task.status ?? "Ready"}
assignee: []
labels: []
milestone: ${task.milestone ?? "m-0"}
dependencies:${task.rawDependencies ?? deps}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
${description}<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
${criteria.map((text, i) => `- [ ] #${i + 1} ${text}`).join("\n")}
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Каждый критерий приёмки покрыт тестом
<!-- DOD:END -->
`;
}

let counter = 0;
const taskPath = (root: string, id: string) => join(root, "backlog/tasks", `${id.toLowerCase()} - Задача.md`);

function setup(...tasks: FixtureTask[]): string {
  counter += 1;
  const root = join(workDir, `repo-${counter}`);
  for (const task of tasks) {
    mkdirSync(dirname(taskPath(root, task.id)), { recursive: true });
    writeFileSync(taskPath(root, task.id), taskFile(task));
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args, "--root", root], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("[SH-089 AC-1] полная задача", () => {
  it("[SH-089 AC-1] код 0 и строка SH-901: OK", () => {
    const result = run(setup({ id: "SH-901" }), "SH-901");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-901: OK");
  });

  it("[SH-089 AC-1] вывод короткий: одна строка на задачу", () => {
    const result = run(setup({ id: "SH-901" }, { id: "SH-902" }), "SH-901", "SH-902");
    expect(result.output.trim().split("\n")).toEqual(["SH-901: OK", "SH-902: OK"]);
  });
});

describe("[SH-089 AC-2] разделы описания", () => {
  it.each(SECTIONS)("[SH-089 AC-2] нет раздела «%s»: код 1 и имя раздела", (name) => {
    const result = run(setup({ id: "SH-903", omit: [name] }), "SH-903");
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-903: ошибок ");
    expect(result.output).toMatch(new RegExp(`ОШИБКА: [^\\n]*${name}`));
  });

  it.each(SECTIONS)("[SH-089 AC-2] пустой раздел «%s»: код 1 и имя раздела", (name) => {
    const result = run(setup({ id: "SH-904", empty: [name] }), "SH-904");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(new RegExp(`ОШИБКА: [^\\n]*${name}`));
  });
});

describe("[SH-089 AC-3] критерии и план тестов", () => {
  it("[SH-089 AC-3] критерий без строки плана: код 1 и номер критерия", () => {
    const result = run(
      setup({
        id: "SH-905",
        criteria: ["а", "б", "в"],
        plan: [
          ["1", "Юнит"],
          ["3", "API"],
        ],
      }),
      "SH-905",
    );
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*AC-2/);
    expect(result.output).not.toMatch(/ОШИБКА: [^\n]*AC-[13]\b/);
  });

  it("[SH-089 AC-3] номер в плане без критерия: код 1 и номер", () => {
    const result = run(
      setup({
        id: "SH-906",
        criteria: ["а", "б"],
        plan: [
          ["1–2", "Юнит"],
          ["5", "API"],
        ],
      }),
      "SH-906",
    );
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*AC-5/);
  });

  it.each(["1–3", "1-3", "1, 2, 3", "1–2, 3"])("[SH-089 AC-3] ячейка «%s» покрывает три критерия: код 0", (cell) => {
    const result = run(setup({ id: "SH-907", criteria: ["а", "б", "в"], plan: [[cell, "Юнит"]] }), "SH-907");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-907: OK");
  });

  it("[SH-089 AC-3] нет ни одного критерия: код 1", () => {
    const result = run(setup({ id: "SH-908", criteria: [], plan: [["1", "Юнит"]] }), "SH-908");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*критери/i);
  });
});

describe("[SH-089 AC-4] уровни плана тестов", () => {
  it("[SH-089 AC-4] неизвестный уровень: код 1 и название уровня", () => {
    const result = run(setup({ id: "SH-909", plan: [["1–2", "Интеграционный"]] }), "SH-909");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*Интеграционный/);
  });

  it("[SH-089 AC-4] шесть допустимых уровней: код 0", () => {
    const levels = ["Юнит", "API", "E2E", "Ручная", "Ревью", "Скрипт"];
    const plan = levels.map((level, i): [string, string] => [String(i + 1), level]);
    const result = run(setup({ id: "SH-910", criteria: levels, plan }), "SH-910");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-910: OK");
  });
});

describe("[SH-089 AC-5] зависимости", () => {
  it("[SH-089 AC-5] зависимость на несуществующую задачу: код 1 и ID", () => {
    const result = run(setup({ id: "SH-911", dependencies: ["SH-999"] }), "SH-911");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*SH-999/);
  });

  it("[SH-089 AC-5] зависимость из более поздней вехи: код 1 и ID", () => {
    const root = setup(
      { id: "SH-912", milestone: "m-1", dependencies: ["SH-913"] },
      { id: "SH-913", milestone: "m-2", status: "Backlog" },
    );
    const result = run(root, "SH-912");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*SH-913/);
  });

  it("[SH-089 AC-5] веху сравниваем по номеру: m-10 позже m-9", () => {
    const root = setup(
      { id: "SH-914", milestone: "m-9", dependencies: ["SH-915"] },
      { id: "SH-915", milestone: "m-10", status: "Done" },
    );
    const result = run(root, "SH-914");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*SH-915/);
  });

  it("[SH-089 AC-5] зависимость из той же или более ранней вехи: код 0", () => {
    const root = setup(
      { id: "SH-916", milestone: "m-2", dependencies: ["SH-917", "SH-918"] },
      { id: "SH-917", milestone: "m-2", status: "Done" },
      { id: "SH-918", milestone: "m-1", status: "Done" },
    );
    const result = run(root, "SH-916");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-916: OK");
  });

  it("[SH-089 AC-5] «зависит от SH-NNN» без этого ID в зависимостях: код 1 и ID", () => {
    const root = setup({ id: "SH-919", why: "Задача зависит от SH-920." }, { id: "SH-920", status: "Done" });
    const result = run(root, "SH-919");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*SH-920/);
  });

  it("[SH-089 AC-5] «зависит от SH-NNN» с этим ID в зависимостях: код 0", () => {
    const root = setup(
      { id: "SH-921", why: "Задача зависит от SH-922.", dependencies: ["SH-922"] },
      { id: "SH-922", status: "Done" },
    );
    expect(run(root, "SH-921").status).toBe(0);
  });
});

describe("[SH-089 AC-6] предупреждения", () => {
  it("[SH-089 AC-6] шаг владельца без «Владелец:»: предупреждение, код 0", () => {
    const result = run(
      setup({ id: "SH-923", steps: ["Написать код.", "Купить домен для стенда.", "Получить токен бота."] }),
      "SH-923",
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-923: ошибок 0, предупреждений 2");
    expect(result.output).toMatch(/ПРЕДУПРЕЖДЕНИЕ: [^\n]*Купить домен/);
    expect(result.output).toMatch(/ПРЕДУПРЕЖДЕНИЕ: [^\n]*Получить токен/);
  });

  it.each([
    "оплатить хостинг",
    "зарегистрировать домен",
    "создать аккаунт в сервисе",
    "получить ключ API",
    "получить секрет приложения",
    "подписать договор",
  ])("[SH-089 AC-6] действие владельца «%s» без метки ловится", (step) => {
    const result = run(setup({ id: "SH-924", steps: [`Затем ${step}.`] }), "SH-924");
    expect(result.output).toContain("ПРЕДУПРЕЖДЕНИЕ");
  });

  it("[SH-089 AC-6] шаг с «Владелец:» не даёт предупреждения", () => {
    const result = run(setup({ id: "SH-925", steps: ["Владелец: купить домен.", "Написать код."] }), "SH-925");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-925: OK");
  });

  it("[SH-089 AC-6] зависимость Ready-задачи в Backlog: предупреждение, код 0", () => {
    const root = setup({ id: "SH-926", dependencies: ["SH-927"] }, { id: "SH-927", status: "Backlog" });
    const result = run(root, "SH-926");
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/ПРЕДУПРЕЖДЕНИЕ: [^\n]*SH-927/);
  });

  it.each(["Done", "In Progress", "Review"])("[SH-089 AC-6] зависимость в статусе %s без предупреждения", (status) => {
    const root = setup({ id: "SH-928", dependencies: ["SH-929"] }, { id: "SH-929", status });
    const result = run(root, "SH-928");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-928: OK");
  });

  it("[SH-089 AC-6] 11 критериев: предупреждение, код 0; 10 критериев: без предупреждения", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `критерий ${i + 1}`);
    const many = run(setup({ id: "SH-930", criteria: eleven, plan: [["1–11", "Юнит"]] }), "SH-930");
    expect(many.status).toBe(0);
    expect(many.output).toMatch(/ПРЕДУПРЕЖДЕНИЕ: [^\n]*11/);

    const ten = run(setup({ id: "SH-931", criteria: eleven.slice(0, 10), plan: [["1–10", "Юнит"]] }), "SH-931");
    expect(ten.status).toBe(0);
    expect(ten.output).toContain("SH-931: OK");
  });
});

describe("[SH-089 AC-7] выбор задач", () => {
  const broken = (id: string, status: string): FixtureTask => ({ id, status, omit: ["Зачем"] });

  it("[SH-089 AC-7] указанный ID проверяется в любом статусе", () => {
    const root = setup(broken("SH-932", "Backlog"), broken("SH-933", "Done"), broken("SH-934", "Ready"));
    const result = run(root, "SH-932", "SH-933");
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-932: ошибок 1");
    expect(result.output).toContain("SH-933: ошибок 1");
    expect(result.output).not.toContain("SH-934");
  });

  it("[SH-089 AC-7] неизвестный ID: код 1", () => {
    const result = run(setup({ id: "SH-935" }), "SH-936");
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-936");
  });

  it("[SH-089 AC-7] без аргументов проверяются все задачи в Ready, остальные пропускаются", () => {
    const root = setup(
      { id: "SH-937" },
      broken("SH-938", "Ready"),
      broken("SH-939", "Backlog"),
      broken("SH-940", "In Progress"),
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-937: OK");
    expect(result.output).toContain("SH-938: ошибок 1");
    expect(result.output).not.toMatch(/SH-9(39|40)/);
  });

  it("[SH-089 AC-7] без аргументов и без задач в Ready: код 0", () => {
    const result = run(setup(broken("SH-941", "Backlog")));
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("SH-941");
  });

  function git(root: string, ...args: string[]) {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return String(result.stdout).trim();
  }

  it("[SH-089 AC-7] --changed проверяет Ready-задачи, изменённые относительно origin/main", () => {
    const root = setup(
      broken("SH-942", "Ready"),
      broken("SH-943", "Ready"),
      broken("SH-944", "Backlog"),
      broken("SH-945", "Ready"),
    );
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    // SH-942 изменён и закоммичен, SH-944 (не Ready) изменён, SH-945 изменён и не закоммичен, SH-943 не тронут.
    for (const id of ["SH-942", "SH-944", "SH-945"]) {
      writeFileSync(taskPath(root, id), `${readFileSync(taskPath(root, id), "utf8")}\nправка\n`);
    }
    git(root, "add", taskPath(root, "SH-942"), taskPath(root, "SH-944"));
    git(root, "commit", "-q", "-m", "change");

    const result = run(root, "--changed");
    expect(result.status).toBe(1);
    expect(result.output).toContain("SH-942: ошибок 1");
    expect(result.output).toContain("SH-945: ошибок 1");
    expect(result.output).not.toMatch(/SH-94[34]/);
  });

  it("[SH-089 AC-7] --changed без изменений в задачах: код 0 и нет вывода о задачах", () => {
    const root = setup(broken("SH-946", "Ready"));
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const result = run(root, "--changed");
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("SH-946");
  });

  it("[SH-089 AC-7] --changed без origin/main: код 1 и понятное сообщение", () => {
    const root = setup({ id: "SH-947" });
    git(root, "init", "-q");
    const result = run(root, "--changed");
    expect(result.status).toBe(1);
    expect(result.output).toContain("origin/main");
  });
});

describe("[SH-089 AC-8] общий разбор задач", () => {
  it("[SH-089 AC-8] scripts/lib/backlog-task.mjs разбирает ячейку AC и план тестов", async () => {
    const lib = await import(pathToFileURL(join(repoRoot, "scripts/lib/backlog-task.mjs")).href);
    expect(lib.parseAcCell("1–3, 5")).toEqual([1, 2, 3, 5]);
    expect(lib.parseAcCell("4-5")).toEqual([4, 5]);
    const plan = lib.parseTestPlan("## План тестов\n| AC | Уровень | Тест |\n|---|---|---|\n| 1–2 | API | х |\n");
    expect([...plan.entries()]).toEqual([
      [1, ["API"]],
      [2, ["API"]],
    ]);
  });

  it("[SH-089 AC-8] оба скрипта берут разбор из lib и не дублируют его", () => {
    const coverage = read("scripts/check-ac-coverage.mjs");
    const spec = read("scripts/check-spec.mjs");
    expect(coverage).toMatch(/from "\.\/lib\/backlog-task\.mjs"/);
    expect(spec).toMatch(/from "\.\/lib\/backlog-task\.mjs"/);
    for (const name of ["parseCriteria", "parseAcCell", "parseTestPlan"]) {
      expect(coverage, name).not.toMatch(new RegExp(`function ${name}\\b`));
      expect(spec, name).not.toMatch(new RegExp(`function ${name}\\b`));
    }
  });
});

describe("[SH-089 AC-9] команда и шаг CI", () => {
  it("[SH-089 AC-9] package.json содержит spec:check", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["spec:check"]).toBe("node scripts/check-spec.mjs");
  });

  it("[SH-089 AC-9] шаг CI запускает --changed только на pull_request и сам получает origin/main", () => {
    const ci = read(".github/workflows/ci.yml");
    const at = ci.indexOf("check-spec.mjs --changed");
    expect(at).toBeGreaterThan(-1);
    const step = ci.slice(
      ci.lastIndexOf("      - name:", at),
      ci.indexOf("\n      - ", at) === -1 ? undefined : ci.indexOf("\n      - ", at),
    );
    expect(step).toContain("github.event_name == 'pull_request'");
    expect(step).toMatch(/git fetch[^\n]*origin[^\n]*main/);
  });
});

describe("[SH-089 AC-10] скилл sh-spec и документы", () => {
  const skill = () => read(".claude/skills/sh-spec/SKILL.md");

  it("[SH-089 AC-10] у скилла есть frontmatter с именем и описанием", () => {
    const text = skill();
    expect(text).toMatch(/^---\nname: sh-spec\ndescription: .+\n---\n/);
  });

  it("[SH-089 AC-10] скилл отсылает к шаблону, Definition of Ready и проверке", () => {
    const text = skill();
    expect(text).toContain("doc.mjs process 4");
    expect(text).toContain("doc.mjs process 5");
    expect(text).toContain("spec:check");
    expect(text).toContain("backlog task create");
  });

  it("[SH-089 AC-10] скилл не копирует шаблон §4", () => {
    const text = skill();
    for (const name of SECTIONS) expect(text, name).not.toMatch(new RegExp(`^#+\\s*${name}\\s*$`, "m"));
    expect(text).not.toContain("|---|---|---|");
    expect(text).not.toContain("глагол + результат");
  });

  it("[SH-089 AC-10] CLAUDE.md сохраняет строку про шаблон и называет скилл и команду", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toContain("node scripts/doc.mjs process 4");
    expect(claude).toContain("node scripts/doc.mjs process 5");
    expect(claude).toContain("sh-spec");
    expect(claude).toContain("pnpm spec:check");
  });

  it("[SH-089 AC-10] process.md и README.md описывают проверку", () => {
    expect(read("docs/process.md")).toContain("pnpm spec:check");
    expect(read("docs/process.md")).toContain("sh-spec");
    expect(read("README.md")).toContain("`pnpm spec:check`");
  });
});

describe("[SH-089 AC-2] границы разделов описания", () => {
  const load = async () => import(pathToFileURL(join(repoRoot, "scripts/lib/backlog-task.mjs")).href);

  it("[SH-089 AC-2] подзаголовок ### не обрывает раздел", async () => {
    const { parseSections } = await load();
    const sections = parseSections("## Зачем\nвступление\n### Детали\nпродолжение\n## Контекст\nссылки\n");
    expect(sections.get("Зачем")).toContain("продолжение");
    expect(sections.has("Детали")).toBe(false);
    expect(sections.get("Контекст")).toBe("ссылки");
  });

  it("[SH-089 AC-2] строка ## внутри блока кода не начинает раздел", async () => {
    const { parseSections } = await load();
    const text = "## Контракт\n```md\n## Не входит\n# комментарий\n```\nпосле\n## Контекст\nссылки\n";
    const sections = parseSections(text);
    expect(sections.has("Не входит")).toBe(false);
    expect(sections.get("Контракт")).toContain("после");
  });

  it("[SH-089 AC-2] повторный заголовок не стирает накопленный текст", async () => {
    const { parseSections } = await load();
    const sections = parseSections("## Зачем\nпервый\n\n## Контекст\nс\n\n## Зачем\nвторой\n");
    expect(sections.get("Зачем")).toContain("первый");
    expect(sections.get("Зачем")).toContain("второй");
  });

  it("[SH-089 AC-2] раздел, где есть только подзаголовок с текстом, не пуст", () => {
    const task = { id: "SH-950", append: { Зачем: "### Детали\nтекст" }, empty: ["Зачем"] };
    const result = run(setup(task), "SH-950");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-950: OK");
  });

  it("[SH-089 AC-2] строка ## Не входит в блоке кода не заменяет отсутствующий раздел", () => {
    const task = { id: "SH-951", omit: ["Не входит"], append: { Контракт: "```md\n## Не входит\nтекст\n```" } };
    const result = run(setup(task), "SH-951");
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ОШИБКА: [^\n]*Не входит/);
  });
});

describe("[SH-089 AC-7] --changed сравнивает с merge-base", () => {
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return String(result.stdout).trim();
  };
  const broken = (id: string): FixtureTask => ({ id, omit: ["Зачем"] });
  const touch = (root: string, id: string) =>
    writeFileSync(taskPath(root, id), `${readFileSync(taskPath(root, id), "utf8")}\nправка\n`);

  it("[SH-089 AC-7] изменения, ушедшие в origin/main после ветвления, не попадают в проверку", () => {
    const root = setup(broken("SH-952"), broken("SH-953"));
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    // origin/main ушёл вперёд: в нём изменён SH-953.
    git(root, "checkout", "-q", "-b", "main-side");
    touch(root, "SH-953");
    git(root, "commit", "-qam", "main moved");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    // Ветка задачи от base меняет SH-952.
    git(root, "checkout", "-q", "-b", "feature", base);
    touch(root, "SH-952");
    git(root, "commit", "-qam", "feature");

    const result = run(root, "--changed");
    expect(result.output).toContain("SH-952: ошибок 1");
    expect(result.output).not.toContain("SH-953");
  });

  it("[SH-089 AC-7] нет общего предка с origin/main: сравнение с вершиной, код 0 или 1 без сбоя git", () => {
    const root = setup(broken("SH-954"), broken("SH-955"));
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "-q", "--orphan", "other");
    touch(root, "SH-954");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "orphan");
    const result = run(root, "--changed");
    expect(result.output).toContain("SH-954: ошибок 1");
    expect(result.output).not.toContain("Не удалось");
  });

  it("[SH-089 AC-7] незакоммиченные и неотслеженные файлы задач проверяются", () => {
    const root = setup(broken("SH-956"), broken("SH-957"));
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    touch(root, "SH-956");
    mkdirSync(dirname(taskPath(root, "SH-958")), { recursive: true });
    writeFileSync(taskPath(root, "SH-958"), taskFile(broken("SH-958")));

    const result = run(root, "--changed");
    expect(result.output).toContain("SH-956: ошибок 1");
    expect(result.output).toContain("SH-958: ошибок 1");
    expect(result.output).not.toContain("SH-957");
  });
});

describe("[SH-089 AC-4] одинаковое понимание уровня в check-spec и ac:check", () => {
  it.each(["Ручная проверка в браузере", "ручная", "Ревью кода", "Скрипт запуска"])(
    "[SH-089 AC-4] уровень «%s» принимает и check-spec, и ac:check (метка не нужна)",
    async (level) => {
      const result = run(setup({ id: "SH-959", plan: [["1–2", level]] }), "SH-959");
      expect(result.status).toBe(0);
      expect(result.output).toContain("SH-959: OK");
      const lib = await import(pathToFileURL(join(repoRoot, "scripts/lib/backlog-task.mjs")).href);
      expect(lib.levelNeedsLabel(level)).toBe(false);
    },
  );

  it.each(["юнит", "API", "e2e", "Unit"])("[SH-089 AC-4] уровень «%s» требует метку в ac:check", async (level) => {
    const lib = await import(pathToFileURL(join(repoRoot, "scripts/lib/backlog-task.mjs")).href);
    expect(lib.levelNeedsLabel(level)).toBe(true);
  });

  it("[SH-089 AC-4] нормализация уровня общая: lib.normalizeLevel возвращает уровень из списка или null", async () => {
    const lib = await import(pathToFileURL(join(repoRoot, "scripts/lib/backlog-task.mjs")).href);
    expect(lib.normalizeLevel("  юнит ")).toBe("Юнит");
    expect(lib.normalizeLevel("Ручная проверка")).toBe("Ручная");
    expect(lib.normalizeLevel("Интеграционный")).toBeNull();
    const coverage = read("scripts/check-ac-coverage.mjs");
    const spec = read("scripts/check-spec.mjs");
    expect(coverage).toContain("levelNeedsLabel");
    expect(spec).toContain("normalizeLevel");
    expect(coverage).not.toContain("LEVELS_WITHOUT_LABEL = [");
  });
});

describe("[SH-089 AC-5] устойчивость разбора зависимостей", () => {
  it("[SH-089 AC-5] dependencies строкой, а не списком: без исключения, зависимость учитывается", () => {
    const root = setup({ id: "SH-960", rawDependencies: " SH-961" }, { id: "SH-961", status: "Backlog" });
    const result = run(root, "SH-960");
    expect(result.output).not.toMatch(/TypeError|at .*\.mjs/);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/ПРЕДУПРЕЖДЕНИЕ: [^\n]*SH-961/);
  });

  it("[SH-089 AC-5] dependencies: null не ломает проверку", () => {
    const result = run(setup({ id: "SH-962", rawDependencies: " null" }), "SH-962");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-962: OK");
  });

  it("[SH-089 AC-5] «не зависит от SH-NNN» не требует записи в зависимостях", () => {
    const root = setup({ id: "SH-963", why: "Задача не зависит от SH-964." }, { id: "SH-964", status: "Done" });
    const result = run(root, "SH-963");
    expect(result.status).toBe(0);
    expect(result.output).toContain("SH-963: OK");
  });

  it("[SH-089 AC-5] «Не зависит от» в начале предложения тоже не считается", () => {
    const root = setup({ id: "SH-965", why: "Не зависит от SH-966." }, { id: "SH-966", status: "Done" });
    expect(run(root, "SH-965").status).toBe(0);
  });
});
