import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-093: скрипт `scripts/factory.mjs` (`pnpm factory run`) и модуль `scripts/lib/factory-state.mjs`.
// Каждый тест собирает во временной папке свой «GitHub» (bare-репозиторий), основную папку и задачи в backlog/tasks.
// `pnpm`, `claude` и `gh` подменяются скриптами в PATH: они пишут вызов в журнал и ничего не делают.
// Настоящая модель и настоящий `pnpm install` не запускаются. ID задач в фикстурах из диапазона SH-9xx.
// AC-15 проверяется в ревью, AC-14 лежит в tools/tests/docs-dedup.test.ts.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/factory.mjs");
const stateUrl = pathToFileURL(join(repoRoot, "scripts/lib/factory-state.mjs")).href;
const factoryUrl = pathToFileURL(script).href;
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "factory-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Подставные pnpm, claude и gh: пишут `<имя> <аргументы> cwd=<папка>` в журнал FAKE_LOG.
// pnpm с FAKE_PNPM_FAIL печатает 25 строк и завершается с кодом 1.
const fakeBin = join(workDir, "bin");
mkdirSync(fakeBin, { recursive: true });
for (const name of ["pnpm", "claude", "gh"]) {
  writeFileSync(
    join(fakeBin, name),
    `#!/bin/sh
echo "${name} $* cwd=$PWD" >> "$FAKE_LOG"
if [ "${name}" = "pnpm" ] && [ -n "$FAKE_PNPM_FAIL" ]; then
  i=1
  while [ $i -le 25 ]; do echo "install-line $i"; i=$((i + 1)); done
  exit 1
fi
echo '{}'
`,
  );
  chmodSync(join(fakeBin, name), 0o755);
}

type FixtureTask = {
  id: string;
  title?: string;
  status?: string;
  deps?: string[];
  priority?: string;
  criteria?: number;
  // Спецификация без раздела «Зачем»: check-spec.mjs отвечает ошибкой.
  broken?: boolean;
};

function taskFile(task: FixtureTask): string {
  const criteria = Array.from({ length: task.criteria ?? 2 }, (_, i) => `критерий ${i + 1}`);
  const sections: Record<string, string> = {
    "Что нужно сделать": "1. Написать код.",
    Зачем: "Нужно для дела.",
    Контекст: "- Правила: ТД §4.2",
    "Не входит": "Остальное.",
    Контракт: "Нет API и БД.",
    "План тестов": [
      "| AC | Уровень | Тест |",
      "|---|---|---|",
      ...criteria.map((_, i) => `| ${i + 1} | Юнит | тест |`),
    ].join("\n"),
  };
  if (task.broken) delete sections.Зачем;
  const description = Object.entries(sections)
    .map(([name, body]) => `## ${name}\n${body}\n`)
    .join("\n");
  const deps = task.deps?.length ? `\n${task.deps.map((d) => `  - ${d}`).join("\n")}` : " []";
  return `---
id: ${task.id}
title: ${JSON.stringify(task.title ?? `Задача ${task.id.slice(3)}`)}
status: ${task.status ?? "Ready"}
assignee: []
labels: []
dependencies:${deps}
priority: ${task.priority ?? "medium"}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
${description}<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
${criteria.map((text, i) => `- [ ] #${i + 1} ${text}`).join("\n")}
<!-- AC:END -->
`;
}

const taskPath = (id: string) => `backlog/tasks/${id.toLowerCase()} - задача.md`;

type Scenario = { base: string; origin: string; work: string; seed: string; log: string; stateDir: string };

type RepoOptions = {
  // Задачи только в рабочей папке основной папки, без коммита.
  workOnly?: FixtureTask[];
  localBranches?: string[];
  originBranches?: string[];
  // Ветки, открытые в worktree вне .claude/worktrees.
  worktreeBranches?: string[];
};

let counter = 0;

// origin/main опережает локальный main основной папки на один коммит: так видно, что ветка берётся от origin/main.
function makeRepo(tasks: FixtureTask[], options: RepoOptions = {}): Scenario {
  counter += 1;
  const base = join(workDir, `case-${counter}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  mkdirSync(base, { recursive: true });
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  mkdirSync(join(seed, "backlog/tasks"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "readme\n");
  writeFileSync(join(seed, ".gitignore"), ".claude/worktrees/\n");
  for (const task of tasks) writeFileSync(join(seed, taskPath(task.id)), taskFile(task));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, work);

  writeFileSync(join(seed, "advance.txt"), "дальше\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "advance");
  git(seed, "push", "-q", "origin", "main");

  for (const branch of options.localBranches ?? []) git(work, "branch", branch, "origin/main");
  for (const branch of options.originBranches ?? []) git(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  for (const branch of options.worktreeBranches ?? [])
    git(work, "worktree", "add", "-q", "-b", branch, join(base, `wt-${branch}`), "origin/main");
  for (const task of options.workOnly ?? []) writeFileSync(join(work, taskPath(task.id)), taskFile(task));
  return { base, origin, work, seed, log: join(base, "fake.log"), stateDir: join(work, ".git/factory") };
}

type RunOptions = { input?: string; env?: Record<string, string>; timeout?: number };

function runFactory(
  scenario: Scenario,
  cwd: string,
  args: string[],
  { input = "", env = {}, timeout }: RunOptions = {},
) {
  writeFileSync(scenario.log, "");
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    input,
    timeout,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: scenario.log, ...env },
  });
  const out = `${result.stdout}${result.stderr}`;
  return {
    code: result.status,
    out,
    seconds: (Date.now() - started) / 1000,
    calls: readFileSync(scenario.log, "utf8"),
  };
}

// Выполняет код ES-модуля в папке cwd. Модуль состояния подключён как `m`.
function nodeEval(cwd: string, code: string, env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import * as m from ${JSON.stringify(stateUrl)};\n${code}`],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// Запись задачи на нужном этапе, созданная через модуль состояния.
function seedRecord(scenario: Scenario, id: string, stage = "подготовлена") {
  const result = nodeEval(
    scenario.work,
    `m.createTask(${JSON.stringify(id)}, { title: "Запись", branch: "sh-x", worktree: "/x" });
     ${stage === "подготовлена" ? "" : `m.setStage(${JSON.stringify(id)}, ${JSON.stringify(stage)}, "тест");`}`,
  );
  if (result.code !== 0) throw new Error(result.err);
}

const readTasks = (scenario: Scenario) =>
  JSON.parse(readFileSync(join(scenario.stateDir, "state.json"), "utf8")).tasks as Record<
    string,
    Record<string, unknown>
  >;
const branchesOf = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
const worktreesOf = (cwd: string) =>
  git(cwd, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));

// Состояние репозитория: по нему видно, что команда ничего не создала.
const snapshot = (scenario: Scenario) => ({
  branches: branchesOf(scenario.work),
  worktrees: worktreesOf(scenario.work),
  state: existsSync(join(scenario.stateDir, "state.json"))
    ? readFileSync(join(scenario.stateDir, "state.json"), "utf8")
    : null,
});

const TITLE_FABRIKA = "Фабрика: запуск задачи командой pnpm factory run";
const BRANCH_901 = "sh-901-fabrika-zapusk-zadachi";
const happy = () => makeRepo([{ id: "SH-901", title: TITLE_FABRIKA }]);

describe("factory: выбор кандидатов", () => {
  const picker = () =>
    makeRepo(
      [
        { id: "SH-901", title: "Первая", priority: "high", criteria: 3 },
        { id: "SH-902", title: "Вторая", deps: ["SH-910"] },
        { id: "SH-903", title: "Ждущая", deps: ["SH-911"] },
        { id: "SH-904", title: "С локальной веткой" },
        { id: "SH-905", title: "С веткой на origin" },
        { id: "SH-906", title: "С записью" },
        { id: "SH-907", title: "С worktree" },
        { id: "SH-909", title: "В работе", status: "In Progress" },
        { id: "SH-910", title: "Готовая", status: "Done" },
        { id: "SH-911", title: "Идущая", status: "In Progress" },
      ],
      {
        localBranches: ["sh-904-lokalnaya"],
        originBranches: ["sh-905-na-origin"],
        worktreeBranches: ["sh-907-worktree"],
        workOnly: [{ id: "SH-908", title: "Только в папке" }],
      },
    );

  it("[SH-093 AC-1] номер получают только задачи Ready с зависимостями в Done без ветки, worktree и записи", () => {
    const s = picker();
    seedRecord(s, "SH-906", "в работе");

    const { code, out } = runFactory(s, s.work, ["run"], { input: "\n" });

    expect(code).toBe(0);
    expect(out).toMatch(/^1\. SH-901 .*Первая.*high.*критериев: 3/m);
    expect(out).toMatch(/^2\. SH-902 .*Вторая/m);
    expect(out).not.toMatch(/^3\./m);
    for (const id of ["SH-904", "SH-905", "SH-906", "SH-907", "SH-909", "SH-910"]) expect(out).not.toContain(id);
  });

  it("[SH-093 AC-1] задача с зависимостью не в Done стоит в блоке «Ждут зависимость» без номера", () => {
    const s = picker();

    const { out } = runFactory(s, s.work, ["run"], { input: "\n" });

    const block = out.slice(out.indexOf("Ждут зависимость"));
    expect(out).toContain("Ждут зависимость");
    expect(block).toContain("SH-903");
    expect(out).not.toMatch(/^\d+\. .*SH-903/m);
  });

  it("[SH-093 AC-1] задача, которая есть только в рабочей папке, не выводится", () => {
    const s = picker();

    const { out } = runFactory(s, s.work, ["run"], { input: "\n" });

    expect(out).toContain("SH-901");
    expect(out).not.toContain("SH-908");
    expect(out).not.toContain("Только в папке");
  });

  it("[SH-093 AC-2] несколько кандидатов: номер запускает выбранную задачу", () => {
    const s = picker();

    const { code, out } = runFactory(s, s.work, ["run"], { input: "2\n" });

    expect(code).toBe(0);
    expect(branchesOf(s.work).filter((name) => name.startsWith("sh-902-"))).toHaveLength(1);
    expect(branchesOf(s.work).filter((name) => name.startsWith("sh-901-"))).toHaveLength(0);
    expect(out).toContain("SH-902");
  });

  it("[SH-093 AC-2] один кандидат: y запускает задачу", () => {
    const s = happy();

    const { code } = runFactory(s, s.work, ["run"], { input: "y\n" });

    expect(code).toBe(0);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
  });

  it.each(["", "n", "abc", "0", "3", "1.5", "-1"])(
    "[SH-093 AC-2] несколько кандидатов, ввод %j: «Ничего не запущено», код 0, ничего не создано",
    (input) => {
      const s = picker();
      const before = snapshot(s);

      const { code, out } = runFactory(s, s.work, ["run"], { input: input === "" ? "" : `${input}\n` });

      expect(code).toBe(0);
      expect(out).toContain("Ничего не запущено");
      expect(snapshot(s)).toEqual(before);
    },
  );

  it.each(["", "\n", "n\n", "abc\n"])(
    "[SH-093 AC-2] один кандидат, ввод %j: «Ничего не запущено», код 0, ничего не создано",
    (input) => {
      const s = happy();
      const before = snapshot(s);

      const { code, out } = runFactory(s, s.work, ["run"], { input });

      expect(code).toBe(0);
      expect(out).toContain("Ничего не запущено");
      expect(snapshot(s)).toEqual(before);
    },
  );

  it("[SH-093 AC-2] кандидатов нет: «Задач в Ready нет», код 0", () => {
    const s = makeRepo([{ id: "SH-909", status: "In Progress" }]);

    const { code, out } = runFactory(s, s.work, ["run"]);

    expect(code).toBe(0);
    expect(out).toContain("Задач в Ready нет");
  });
});

describe("factory: run SH-NNN", () => {
  it("[SH-093 AC-3] кандидат запускается без вопроса", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, ["run", "SH-901"]);

    expect(code).toBe(0);
    expect(out).not.toMatch(/\[y\/n\]|Номер/);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
  });

  const refusals: { name: string; id: string; reason: RegExp; setup?: (s: Scenario) => void }[] = [
    { name: "нет в origin/main", id: "SH-999", reason: /нет в origin\/main/ },
    { name: "не Ready", id: "SH-909", reason: /статус In Progress/ },
    { name: "зависимость не в Done", id: "SH-903", reason: /зависимость SH-911/ },
    { name: "есть локальная ветка", id: "SH-904", reason: /ветк.*sh-904-lokalnaya/ },
    { name: "есть ветка на origin", id: "SH-905", reason: /ветк.*origin\/sh-905-na-origin/ },
    {
      name: "есть запись на другом этапе",
      id: "SH-906",
      reason: /этапе «в работе»/,
      setup: (s) => seedRecord(s, "SH-906", "в работе"),
    },
  ];

  it.each(refusals)("[SH-093 AC-3] $name: причина, код 1, ничего не создано", ({ id, reason, setup }) => {
    const s = makeRepo(
      [
        { id: "SH-903", deps: ["SH-911"] },
        { id: "SH-904" },
        { id: "SH-905" },
        { id: "SH-906" },
        { id: "SH-909", status: "In Progress" },
        { id: "SH-911", status: "In Progress" },
      ],
      { localBranches: ["sh-904-lokalnaya"], originBranches: ["sh-905-na-origin"] },
    );
    setup?.(s);
    const before = snapshot(s);

    const { code, out, calls } = runFactory(s, s.work, ["run", id]);

    expect(code).toBe(1);
    expect(out).toMatch(reason);
    expect(snapshot(s)).toEqual(before);
    expect(calls).not.toContain("pnpm");
  });

  it("[SH-093 AC-3] задача только в рабочей папке: нет в origin/main, код 1", () => {
    const s = makeRepo([{ id: "SH-901" }], { workOnly: [{ id: "SH-908" }] });

    const { code, out } = runFactory(s, s.work, ["run", "SH-908"]);

    expect(code).toBe(1);
    expect(out).toMatch(/нет в origin\/main/);
  });
});

describe("factory: ветка и worktree", () => {
  it("[SH-093 AC-4] ветка sh-NNN-slug и worktree в .claude/worktrees создаются от origin/main", () => {
    const s = happy();

    const { code } = runFactory(s, s.work, ["run", "SH-901"]);

    const worktree = join(s.work, ".claude/worktrees", BRANCH_901);
    expect(code).toBe(0);
    expect(existsSync(join(worktree, "backlog/tasks"))).toBe(true);
    expect(worktreesOf(s.work)).toContain(`worktree ${worktree}`);
    expect(git(worktree, "branch", "--show-current")).toBe(BRANCH_901);
    // origin/main опережает локальный main на коммит advance: ветка стоит на нём.
    expect(git(s.work, "rev-parse", BRANCH_901)).toBe(git(s.seed, "rev-parse", "main"));
    expect(existsSync(join(worktree, "advance.txt"))).toBe(true);
  });

  const slugOf = (titles: string[]): string[] => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { slugify } from ${JSON.stringify(factoryUrl)};
         console.log(JSON.stringify(${JSON.stringify(titles)}.map(slugify)));`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };

  const slugs: [string, string][] = [
    [TITLE_FABRIKA, "fabrika-zapusk-zadachi"],
    ["Объём подъёма", "obem-podema"],
    ["Подъезд, мальчик", "podezd-malchik"],
    ["Жёлтый хутор цапля щука", "zheltyy-khutor-tsaplya"],
    ["Щука юла яма", "shchuka-yula-yama"],
    ["Hello, world: Foo bar", "hello-world-foo"],
    ["SH 12 API", "sh-12-api"],
    ["Добавить 2FA", "dobavit-2fa"],
    ["A/B_test, v2.0!", "a-b-test"],
    ["ВЕРХНИЙ Регистр", "verkhniy-registr"],
    ["!!! ??? ...", "task"],
    ["", "task"],
    ["Подтверждение регистрации преподавателя", "podtverzhdenie-registratsii"],
    ["Интернационализация конфигурации сервера", "internatsionalizatsiya"],
    [`${"a".repeat(15)} ${"b".repeat(14)}`, `${"a".repeat(15)}-${"b".repeat(14)}`],
    [`${"a".repeat(15)} ${"b".repeat(15)}`, "a".repeat(15)],
    ["x".repeat(40), "x".repeat(30)],
    [`${"x".repeat(40)} мир`, "x".repeat(30)],
  ];

  it("[SH-093 AC-5] slug строится по таблице транслитерации, по трём словам и с обрезкой до 30", () => {
    expect(slugOf(slugs.map(([title]) => title))).toEqual(slugs.map(([, slug]) => slug));
  });
});

describe("factory: ошибки подготовки", () => {
  it("[SH-093 AC-6] check-spec с ошибкой: печатает его вывод, убирает worktree и ветку, записи нет", () => {
    const s = makeRepo([{ id: "SH-901", title: TITLE_FABRIKA, broken: true }]);
    const before = snapshot(s);

    const { code, out, calls } = runFactory(s, s.work, ["run", "SH-901"]);

    expect(code).toBe(1);
    expect(out).toContain("ОШИБКА: нет раздела «Зачем»");
    expect(snapshot(s)).toEqual(before);
    expect(existsSync(join(s.work, ".claude/worktrees", BRANCH_901))).toBe(false);
    expect(calls).not.toContain("pnpm install");
  });

  it("[SH-093 AC-6] падающий pnpm install: последние 20 строк вывода, worktree и ветки нет, записи нет", () => {
    const s = happy();
    const before = snapshot(s);

    const { code, out, calls } = runFactory(s, s.work, ["run", "SH-901"], { env: { FAKE_PNPM_FAIL: "1" } });

    expect(code).toBe(1);
    expect(out).toMatch(/^install-line 25$/m);
    expect(out).toMatch(/^install-line 6$/m);
    expect(out).not.toMatch(/^install-line 5$/m);
    expect(calls).toContain("pnpm install --frozen-lockfile");
    expect(calls).toContain(`cwd=${join(s.work, ".claude/worktrees", BRANCH_901)}`);
    expect(snapshot(s)).toEqual(before);
    expect(existsSync(join(s.work, ".claude/worktrees", BRANCH_901))).toBe(false);
  });
});

describe("factory: состояние", () => {
  it("[SH-093 AC-7] журнал получает строку «этап: — → подготовлена», вывод называет ID и ветку", () => {
    const s = happy();

    const { code, out, calls } = runFactory(s, s.work, ["run", "SH-901"]);

    expect(code).toBe(0);
    expect(out).toContain("SH-901");
    expect(out).toContain(BRANCH_901);
    const log = readFileSync(join(s.stateDir, "SH-901/log.txt"), "utf8");
    expect(log).toMatch(/^\S+ этап: — → подготовлена; /m);
    expect(log).toMatch(/git worktree add/);
    expect(calls).toContain("pnpm install --frozen-lockfile");
    expect(calls).not.toMatch(/^(claude|gh) /m);
  });

  it("[SH-093 AC-7] запись задачи получает начальные значения полей", () => {
    const s = happy();

    runFactory(s, s.work, ["run", "SH-901"]);

    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({
      id: "SH-901",
      title: TITLE_FABRIKA,
      branch: BRANCH_901,
      worktree: join(s.work, ".claude/worktrees", BRANCH_901),
      stage: "подготовлена",
      session_id: "",
      session_ready: false,
      cost_usd: 0,
      rounds: 0,
      rounds_total: 0,
      denials: [],
      pr_url: "",
    });
    expect(Object.keys(task)).toEqual(
      expect.arrayContaining([
        "stage_changed_at",
        "reason",
        "pid",
        "pid_started_at",
        "verify_summary",
        "review_count",
        "updated_at",
      ]),
    );
  });

  it("[SH-093 AC-8] state.json и log.txt лежат в <git common dir>/factory/, рабочие деревья чисты", () => {
    const s = happy();

    runFactory(s, s.work, ["run", "SH-901"]);

    const worktree = join(s.work, ".claude/worktrees", BRANCH_901);
    expect(git(s.work, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(s.work, ".git"));
    expect(existsSync(join(s.stateDir, "state.json"))).toBe(true);
    expect(existsSync(join(s.stateDir, "SH-901/log.txt"))).toBe(true);
    expect(git(s.work, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("[SH-093 AC-9] запуск из worktree другой ветки использует ту же основную папку и тот же state.json", () => {
    const s = happy();
    const other = join(s.base, "other-wt");
    git(s.work, "worktree", "add", "-q", "-b", "other-branch", other, "origin/main");

    const { code } = runFactory(s, other, ["run", "SH-901"]);

    expect(code).toBe(0);
    expect(worktreesOf(s.work)).toContain(`worktree ${join(s.work, ".claude/worktrees", BRANCH_901)}`);
    expect(existsSync(join(s.work, ".claude/worktrees", BRANCH_901))).toBe(true);
    expect(readTasks(s)["SH-901"]).toBeDefined();
    expect(existsSync(join(s.work, ".git/worktrees/other-wt/factory"))).toBe(false);
    expect(existsSync(join(other, ".claude"))).toBe(false);
  });
});

describe("factory-state: модуль", () => {
  it("[SH-093 AC-10] экспортирует функции, этапы и списки этапов", () => {
    const s = happy();

    const { code, out } = nodeEval(
      s.work,
      `console.log(JSON.stringify({
        fns: ["readState", "createTask", "updateTask", "setStage"].map((name) => typeof m[name]),
        STAGES: m.STAGES,
        RUNNING: m.STAGES_RUNNING,
        WAIT: m.STAGES_WAIT_OWNER,
      }));`,
    );

    expect(code).toBe(0);
    const exported = JSON.parse(out);
    expect(exported.fns).toEqual(["function", "function", "function", "function"]);
    expect(exported.STAGES).toEqual([
      "подготовлена",
      "в работе",
      "готово",
      "стоп",
      "ошибка",
      "проверки",
      "нужен владелец",
      "нужен штаб",
      "ошибка проверок",
      "готово к PR",
      "ошибка PR",
      "PR",
      "Done, ждёт слияния",
    ]);
    expect(exported.RUNNING).toEqual(["в работе", "проверки"]);
    expect([...exported.WAIT].sort()).toEqual(
      [
        "готово",
        "стоп",
        "ошибка",
        "нужен владелец",
        "нужен штаб",
        "ошибка проверок",
        "готово к PR",
        "ошибка PR",
        "PR",
        "Done, ждёт слияния",
      ].sort(),
    );
    expect(exported.RUNNING).not.toContain("подготовлена");
    expect(exported.WAIT).not.toContain("подготовлена");
  });

  it("[SH-093 AC-10] readState без файла пуст; createTask, updateTask и setStage меняют запись и ловят ошибки", () => {
    const s = happy();

    const { code, out, err } = nodeEval(
      s.work,
      `const result = {};
       result.empty = m.readState();
       m.createTask("SH-950", { title: "Т", branch: "sh-950-t", worktree: "/w" });
       m.updateTask("SH-950", { cost_usd: 1.5, pid: 7 });
       m.updateTask("SH-950", (task) => ({ rounds: task.rounds + 2 }));
       m.setStage("SH-950", "в работе", "старт");
       result.task = m.readState().tasks["SH-950"];
       for (const [name, call] of Object.entries({
         unknownId: () => m.updateTask("SH-951", { rounds: 1 }),
         unknownStage: () => m.setStage("SH-950", "летит", "x"),
       })) {
         try { call(); result[name] = "нет ошибки"; } catch (error) { result[name] = "ошибка"; }
       }
       console.log(JSON.stringify(result));`,
    );

    expect(err).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.empty.tasks).toEqual({});
    expect(result.task).toMatchObject({
      id: "SH-950",
      stage: "в работе",
      reason: "старт",
      cost_usd: 1.5,
      pid: 7,
      rounds: 2,
      rounds_total: 0,
    });
    expect(result.unknownId).toBe("ошибка");
    expect(result.unknownStage).toBe("ошибка");
    const log = readFileSync(join(s.stateDir, "SH-950/log.txt"), "utf8");
    expect(log).toMatch(/этап: — → подготовлена/);
    expect(log).toMatch(/этап: подготовлена → в работе; старт/);
  });

  it("[SH-093 AC-11] два процесса по 50 раз увеличивают rounds и rounds_total, ни одно изменение не теряется", async () => {
    const s = happy();
    seedRecord(s, "SH-950");
    const worker = (field: string) =>
      new Promise<number | null>((done) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import * as m from ${JSON.stringify(stateUrl)};
             for (let i = 0; i < 50; i += 1) m.updateTask("SH-950", (task) => ({ ${field}: task.${field} + 1 }));`,
          ],
          { cwd: s.work, stdio: "ignore" },
        );
        child.on("close", done);
      });

    const codes = await Promise.all([worker("rounds"), worker("rounds_total")]);

    expect(codes).toEqual([0, 0]);
    expect(readTasks(s)["SH-950"]).toMatchObject({ rounds: 50, rounds_total: 50 });
  }, 60_000);

  it("[SH-093 AC-12] блокировка state.lock старше 30 секунд снимается, запись проходит", () => {
    const s = happy();
    seedRecord(s, "SH-950");
    const lock = join(s.stateDir, "state.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);

    const { code, err } = nodeEval(s.work, `m.updateTask("SH-950", { rounds: 5 });`);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(readTasks(s)["SH-950"].rounds).toBe(5);
    expect(existsSync(lock)).toBe(false);
  });

  it("[SH-093 AC-13] свежая блокировка state.lock за 5 секунд: «Состояние занято», код 1, всё убрано", () => {
    const s = happy();
    seedRecord(s, "SH-950");
    const stateBefore = readFileSync(join(s.stateDir, "state.json"), "utf8");
    const lock = join(s.stateDir, "state.lock");
    mkdirSync(lock);
    const before = snapshot(s);

    const { code, out, seconds } = runFactory(s, s.work, ["run", "SH-901"], { timeout: 30_000 });

    expect(code).toBe(1);
    expect(out).toContain("Состояние занято");
    expect(seconds).toBeGreaterThanOrEqual(4.5);
    expect(readFileSync(join(s.stateDir, "state.json"), "utf8")).toBe(stateBefore);
    expect(snapshot(s)).toEqual(before);
    expect(existsSync(join(s.work, ".claude/worktrees", BRANCH_901))).toBe(false);
    expect(existsSync(lock)).toBe(true);
  }, 60_000);
});
