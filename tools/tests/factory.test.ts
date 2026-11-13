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

// Тесты SH-093 и SH-098: скрипт `scripts/factory.mjs` (`pnpm factory run`), модули `scripts/lib/factory-state.mjs`,
// `scripts/lib/factory-tools.mjs` и `scripts/lib/local-env.mjs`.
// Каждый тест собирает во временной папке свой «GitHub» (bare-репозиторий), основную папку и задачи в backlog/tasks.
// `pnpm`, `claude` и `gh` подменяются скриптами в PATH. `pnpm` и `gh` пишут вызов в журнал и ничего не делают.
// `claude` пишет аргументы, `cwd` и окружение в `<журнал>.claude` и печатает заготовленный JSON.
// Настоящая модель и настоящий `pnpm install` не запускаются. ID задач в фикстурах из диапазона SH-9xx.
// SH-093: AC-15 проверяется в ревью, AC-14 лежит в tools/tests/docs-dedup.test.ts.
// SH-098: AC-17, AC-18 и AC-19 ручные, AC-22 проверяется в ревью.

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

// Подставные pnpm и gh: пишут `<имя> <аргументы> cwd=<папка>` в журнал FAKE_LOG.
// pnpm с FAKE_PNPM_FAIL печатает 25 строк и завершается с кодом 1.
const fakeBin = join(workDir, "bin");
mkdirSync(fakeBin, { recursive: true });
for (const name of ["pnpm", "gh"]) {
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

// Подставной claude: строка JSON `{ args, cwd, env }` в `<FAKE_LOG>.claude`, затем ответ.
// Ответ по умолчанию: «СТОП <ID из промпта>: заглушка», другой session_id, стоимость 0, отказов нет.
// Настройка: FAKE_CLAUDE_RESULT (текст result), FAKE_CLAUDE_SESSION=same (session_id из --session-id),
// FAKE_CLAUDE_COST, FAKE_CLAUDE_SLEEP (мс до ответа), FAKE_CLAUDE_RAW (stdout как есть), FAKE_CLAUDE_EXIT (код).
writeFileSync(
  join(fakeBin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.FAKE_LOG + ".claude", JSON.stringify({ args, cwd: process.cwd(), env }) + "\\n");
const after = (flag) => args[args.indexOf(flag) + 1] ?? "";
if (env.FAKE_CLAUDE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_CLAUDE_SLEEP));
const id = /SH-\\d+/.exec(after("-p"))?.[0] ?? "SH-0";
const reply = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: env.FAKE_CLAUDE_RESULT ?? "СТОП " + id + ": заглушка",
  session_id: env.FAKE_CLAUDE_SESSION === "same" ? after("--session-id") : "other-session",
  total_cost_usd: Number(env.FAKE_CLAUDE_COST ?? 0),
  permission_denials: [],
};
process.stdout.write(env.FAKE_CLAUDE_RAW ?? JSON.stringify(reply));
process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 0);
`,
);
chmodSync(join(fakeBin, "claude"), 0o755);

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
  // Задачи в backlog/archive/tasks и backlog/completed в origin/main.
  archived?: FixtureTask[];
  completed?: FixtureTask[];
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
  for (const [dir, list] of [
    ["backlog/archive/tasks", options.archived],
    ["backlog/completed", options.completed],
  ] as const) {
    if (!list) continue;
    mkdirSync(join(seed, dir), { recursive: true });
    for (const task of list) writeFileSync(join(seed, dir, `${task.id.toLowerCase()} - задача.md`), taskFile(task));
  }
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

type RunOptions = { input?: string; env?: Record<string, string>; timeout?: number; settle?: boolean };

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const stateFileOf = (scenario: Scenario) => join(scenario.stateDir, "state.json");

// Записи, у которых есть pid: фоновый процесс фабрики ещё работает или не успел очистить запись.
function pidRecords(scenario: Scenario): string[] {
  if (!existsSync(stateFileOf(scenario))) return [];
  const tasks = JSON.parse(readFileSync(stateFileOf(scenario), "utf8")).tasks as Record<string, { pid: number | null }>;
  return Object.entries(tasks)
    .filter(([, task]) => task.pid)
    .map(([id]) => id);
}

// Ждёт, пока условие станет истинным; возвращает false по таймауту.
function waitUntil(condition: () => boolean, seconds = 15): boolean {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (condition()) return true;
    sleepMs(50);
  }
  return condition();
}

// Ждёт, пока все фоновые процессы фабрики очистят pid: тест не оставляет процессов, пишущих в удалённую папку.
const settle = (scenario: Scenario) => waitUntil(() => pidRecords(scenario).length === 0);

function runFactory(
  scenario: Scenario,
  cwd: string,
  args: string[],
  { input = "", env = {}, timeout, settle: wait = true }: RunOptions = {},
) {
  writeFileSync(scenario.log, "");
  writeFileSync(`${scenario.log}.claude`, "");
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    input,
    timeout,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: scenario.log, ...env },
  });
  const out = `${result.stdout}${result.stderr}`;
  const seconds = (Date.now() - started) / 1000;
  if (wait) settle(scenario);
  return { code: result.status, out, seconds, calls: readFileSync(scenario.log, "utf8") };
}

type ClaudeCall = { args: string[]; cwd: string; env: Record<string, string> };

// Вызовы заглушки claude с начала последнего runFactory.
const claudeCalls = (scenario: Scenario): ClaudeCall[] =>
  readFileSync(`${scenario.log}.claude`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// Значение флага в аргументах claude.
const flagValue = (call: ClaudeCall, flag: string) => call.args[call.args.indexOf(flag) + 1];

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
  const picker = () => {
    const s = makeRepo(
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
    seedRecord(s, "SH-906", "в работе");
    return s;
  };

  it("[SH-093 AC-1] номер получают только задачи Ready с зависимостями в Done без ветки, worktree и записи", () => {
    const s = picker();

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

describe("factory: зависимости в архиве", () => {
  it("[SH-093 AC-1] зависимость в backlog/archive/tasks со статусом Done не блокирует кандидата", () => {
    const s = makeRepo([{ id: "SH-921", title: "Зависит от архивной", deps: ["SH-920"] }], {
      archived: [{ id: "SH-920", title: "Архивная", status: "Done" }],
    });

    const { code, out } = runFactory(s, s.work, ["run"], { input: "\n" });

    expect(code).toBe(0);
    expect(out).toMatch(/1\.\s+SH-921/);
    expect(out).not.toContain("Ждут зависимость");
  });

  it("[SH-093 AC-1] зависимость в backlog/completed со статусом Done не блокирует кандидата", () => {
    const s = makeRepo([{ id: "SH-921", title: "Зависит от завершённой", deps: ["SH-920"] }], {
      completed: [{ id: "SH-920", title: "Завершённая", status: "Done" }],
    });

    const { code, out } = runFactory(s, s.work, ["run"], { input: "\n" });

    expect(code).toBe(0);
    expect(out).toMatch(/1\.\s+SH-921/);
    expect(out).not.toContain("Ждут зависимость");
  });

  it("[SH-093 AC-1] архивная зависимость не в Done остаётся блокирующей", () => {
    const s = makeRepo([{ id: "SH-921", title: "Ждёт архивную", deps: ["SH-920"] }], {
      archived: [{ id: "SH-920", title: "Архивная", status: "In Progress" }],
    });

    const { code, out } = runFactory(s, s.work, ["run"], { input: "\n" });

    expect(code).toBe(0);
    expect(out).toContain("Ждут зависимость");
    expect(out).toMatch(/SH-921/);
    expect(out).toContain("Задач в Ready нет");
  });

  it("[SH-093 AC-1] архивная задача в Ready не кандидат, а запуск по ID отвечает «нет в origin/main»", () => {
    const s = makeRepo([{ id: "SH-921" }], { archived: [{ id: "SH-922", status: "Ready" }] });

    const listed = runFactory(s, s.work, ["run"], { input: "\n" });
    const wanted = runFactory(s, s.work, ["run", "SH-922"]);

    expect(listed.out).not.toContain("SH-922");
    expect(wanted.code).toBe(1);
    expect(wanted.out).toMatch(/нет в origin\/main/);
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
    expect(calls).not.toMatch(/^gh /m);
  });

  // После SH-098 команда запускает воркер: этап, session_id и reason уже ответ заглушки, а не начальные значения.
  it("[SH-093 AC-7] запись задачи получает начальные значения полей", () => {
    const s = happy();

    runFactory(s, s.work, ["run", "SH-901"]);

    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({
      id: "SH-901",
      title: TITLE_FABRIKA,
      branch: BRANCH_901,
      worktree: join(s.work, ".claude/worktrees", BRANCH_901),
      session_ready: false,
      cost_usd: 0,
      rounds: 0,
      rounds_total: 0,
      denials: [],
      pr_url: "",
    });
    expect(Object.keys(task ?? {})).toEqual(
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
    expect(readTasks(s)["SH-950"]?.rounds).toBe(5);
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
  it("[SH-093 AC-12] процесс снимает только свою блокировку: чужая, взятая после отбора своей, остаётся", () => {
    const s = happy();
    seedRecord(s, "SH-950");
    const lock = join(s.stateDir, "state.lock");

    // Внутри записи имитируем второй процесс: он забрал «брошенную» блокировку и взял свою.
    const { code, err } = nodeEval(
      s.work,
      `import { rmSync, mkdirSync } from "node:fs";
       m.updateTask("SH-950", (task) => {
         rmSync(${JSON.stringify(lock)}, { recursive: true, force: true });
         mkdirSync(${JSON.stringify(lock)});
         return { rounds: task.rounds + 1 };
       });`,
    );

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(existsSync(lock)).toBe(true);
  });

  it("[SH-093 AC-12] после обычной записи своя блокировка снята", () => {
    const s = happy();
    seedRecord(s, "SH-950");

    const { code, err } = nodeEval(s.work, `m.updateTask("SH-950", { rounds: 1 });`);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(existsSync(join(s.stateDir, "state.lock"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SH-098: запуск воркера и разбор ответа.

const factoryTools = () => import("../../scripts/lib/factory-tools.mjs");
const factoryModule = () => import("../../scripts/factory.mjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLOW = { FAKE_CLAUDE_SLEEP: "2500" };

// Выполняет код ES-модуля в папке cwd. Модули состояния и фабрики подключены как `m` и `f`.
function nodeEvalAll(cwd: string, code: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(stateUrl)};\nimport * as f from ${JSON.stringify(factoryUrl)};\n${code}`,
    ],
    { cwd, encoding: "utf8" },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// Задача, подготовленная командой SH-093, но без запуска воркера: ветка, worktree и запись на этапе «подготовлена».
function prepared(s: Scenario, id = "SH-901", title = TITLE_FABRIKA, branch = BRANCH_901, fields = "") {
  const worktree = join(s.work, ".claude/worktrees", branch);
  git(s.work, "worktree", "add", "-q", "--no-track", "-b", branch, worktree, "origin/main");
  const result = nodeEvalAll(
    s.work,
    `m.createTask(${JSON.stringify(id)}, { title: ${JSON.stringify(title)}, branch: ${JSON.stringify(branch)}, worktree: ${JSON.stringify(worktree)}, reason: "ветка и worktree готовы"${fields} });`,
  );
  if (result.code !== 0) throw new Error(result.err);
  return { worktree, branch };
}

const logOf = (s: Scenario, id: string) => readFileSync(join(s.stateDir, id, "log.txt"), "utf8");

// Живые процессы, которые тест запускает как «фоновые процессы фабрики». Завершаются после всех тестов.
const sleepers: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const child of sleepers) child.kill();
});
async function liveProcess() {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  sleepers.push(child);
  const { processStartedAt } = await factoryModule();
  expect(waitUntil(() => processStartedAt(child.pid ?? 0) !== "", 5)).toBe(true);
  return { pid: child.pid as number, startedAt: processStartedAt(child.pid as number) };
}

describe("factory: запуск воркера в фоне", () => {
  it("[SH-098 AC-1] без --foreground: этап «в работе» с pid и временем старта, код 0 до ответа claude", async () => {
    const s = happy();

    const { code } = runFactory(s, s.work, ["run", "SH-901"], { env: SLOW, settle: false });

    try {
      expect(code).toBe(0);
      const task = readTasks(s)["SH-901"];
      expect(task?.stage).toBe("в работе");
      expect(task?.pid).toEqual(expect.any(Number));
      const { isAlive, processStartedAt } = await factoryModule();
      expect(task?.pid_started_at).toBe(processStartedAt(task?.pid as number));
      expect(isAlive(task)).toBe(true);
    } finally {
      expect(settle(s)).toBe(true);
    }
    const done = readTasks(s)["SH-901"];
    expect(done?.stage).toBe("стоп");
    expect(done?.pid).toBeNull();
  }, 20_000);

  it("[SH-098 AC-2] без --foreground: session_id в записи, вывод ID, ветки и журнала, процесс — подкоманда _worker", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, ["run", "SH-901"], { env: SLOW, settle: false });

    try {
      expect(code).toBe(0);
      expect(out).toContain("SH-901");
      expect(out).toContain(BRANCH_901);
      expect(out).toContain(join(s.work, ".git/factory/SH-901/log.txt"));
      const task = readTasks(s)["SH-901"];
      expect(task?.session_id).toMatch(UUID);
      const command = spawnSync("ps", ["-o", "command=", "-p", String(task?.pid)], { encoding: "utf8" }).stdout;
      expect(command).toContain("factory.mjs _worker SH-901");
    } finally {
      expect(settle(s)).toBe(true);
    }
    expect(flagValue(claudeCalls(s)[0] as ClaudeCall, "--session-id")).toBe(readTasks(s)["SH-901"]?.session_id);
  }, 20_000);

  it("[SH-098 AC-3] --foreground: pid и время старта текущего процесса, команда ждёт ответа claude", async () => {
    const s = happy();
    prepared(s);
    writeFileSync(s.log, "");
    writeFileSync(`${s.log}.claude`, "");
    const child = spawn(process.execPath, [script, "run", "SH-901", "--foreground"], {
      cwd: s.work,
      stdio: "ignore",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: s.log, ...SLOW },
    });
    const exited = new Promise<number | null>((done) => child.once("exit", done));

    expect(waitUntil(() => readTasks(s)["SH-901"]?.stage === "в работе")).toBe(true);
    const task = readTasks(s)["SH-901"];
    expect(task?.pid).toBe(child.pid);
    const { processStartedAt } = await factoryModule();
    expect(task?.pid_started_at).toBe(processStartedAt(child.pid as number));
    expect(child.exitCode).toBeNull();

    expect(await exited).toBe(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
  }, 20_000);

  it("[SH-098 AC-15] --foreground на заглушке: 001-worker.json, этап, reason, стоимость, строка claude в журнале, pid очищен", () => {
    const s = happy();
    prepared(s);

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], { env: { FAKE_CLAUDE_COST: "0.25" } });

    expect(code).toBe(0);
    const reply = JSON.parse(readFileSync(join(s.stateDir, "SH-901/001-worker.json"), "utf8"));
    expect(reply.result).toBe("СТОП SH-901: заглушка");
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ stage: "стоп", reason: "СТОП SH-901: заглушка", pid: null, pid_started_at: "" });
    expect(task?.cost_usd).toBeCloseTo(0.25);
    const log = logOf(s, "SH-901");
    expect(log).toMatch(/claude -p .*--agent sh-worker/);
    expect(log).toMatch(/этап: подготовлена → в работе/);
    expect(log).toMatch(/этап: в работе → стоп; СТОП SH-901: заглушка/);
  }, 20_000);

  it("[SH-098 AC-15] быстрый ответ заглушки не обгоняет запись этапа «в работе»: в журнале «в работе» раньше «готово»", () => {
    const s = happy();
    prepared(s);

    runFactory(s, s.work, ["run", "SH-901"], { env: { FAKE_CLAUDE_RESULT: "ГОТОВО SH-901" } });

    const log = logOf(s, "SH-901");
    expect(log.indexOf("подготовлена → в работе")).toBeGreaterThan(-1);
    expect(log.indexOf("в работе → готово")).toBeGreaterThan(log.indexOf("подготовлена → в работе"));
    expect(readTasks(s)["SH-901"]).toMatchObject({ stage: "готово", reason: "", pid: null });
  }, 20_000);
});

describe("factory: run SH-NNN после подготовки", () => {
  it("[SH-098 AC-4] запись «подготовлена»: воркер запущен, check-spec и pnpm install не вызваны", () => {
    const s = happy();
    prepared(s);

    const { code, calls } = runFactory(s, s.work, ["run", "SH-901"]);

    expect(code).toBe(0);
    expect(claudeCalls(s)).toHaveLength(1);
    expect(calls).not.toContain("pnpm");
    expect(logOf(s, "SH-901")).not.toContain("check-spec");
    expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
  }, 20_000);

  it.each(["в работе", "готово", "стоп", "ошибка"])(
    "[SH-098 AC-4] запись на этапе «%s»: причина, код 1, воркер не запущен",
    (stage) => {
      const s = happy();
      seedRecord(s, "SH-901", stage);
      const before = snapshot(s);

      const { code, out, calls } = runFactory(s, s.work, ["run", "SH-901"]);

      expect(code).toBe(1);
      expect(out).toContain(`этапе «${stage}»`);
      expect(claudeCalls(s)).toHaveLength(0);
      expect(calls).not.toContain("pnpm");
      expect(snapshot(s)).toEqual(before);
    },
  );
});

describe("factory: команда claude и окружение", () => {
  it("[SH-098 AC-5] аргументы и cwd вызова claude, --session-id равен session_id записи", async () => {
    const s = happy();
    const { worktree } = prepared(s);
    const { workerAllowed, WORKER_DISALLOWED, WORKER_BUDGET_USD } = await factoryTools();

    runFactory(s, s.work, ["run", "SH-901"]);

    const calls = claudeCalls(s);
    expect(calls).toHaveLength(1);
    const sessionId = readTasks(s)["SH-901"]?.session_id;
    expect(sessionId).toMatch(UUID);
    expect(calls[0]?.args).toEqual([
      "-p",
      `Новый старт SH-901. Ветка: ${BRANCH_901}.`,
      "--agent",
      "sh-worker",
      "--session-id",
      sessionId,
      "--name",
      "Фабрика SH-901",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      workerAllowed(worktree).join(","),
      "--disallowedTools",
      WORKER_DISALLOWED.join(","),
      "--max-budget-usd",
      String(WORKER_BUDGET_USD),
    ]);
    expect(calls[0]?.cwd).toBe(worktree);
  }, 20_000);

  it("[SH-098 AC-20] claude получает TEST_DATABASE_URL из .env основной папки, не получает переменные вне ALLOWED", () => {
    const s = happy();
    const { worktree } = prepared(s);
    writeFileSync(
      join(s.work, ".env"),
      "TEST_DATABASE_URL=postgres://main/db_test\nPOSTGRES_PORT=5434\nS3_SECRET_ACCESS_KEY=секрет-фикстуры\n",
    );
    writeFileSync(join(worktree, ".env"), "POSTGRES_PORT=5999\n");

    runFactory(s, s.work, ["run", "SH-901"], {
      env: { POSTGRES_PORT: "5111", DATABASE_URL: "postgres://process/db", S3_SECRET_ACCESS_KEY: "" },
    });

    const env = claudeCalls(s)[0]?.env ?? {};
    expect(env.TEST_DATABASE_URL).toBe("postgres://main/db_test");
    expect(env.POSTGRES_PORT).toBe("5999");
    expect(env.DATABASE_URL).toBe("postgres://process/db");
    expect(env.S3_SECRET_ACCESS_KEY).not.toBe("секрет-фикстуры");
  }, 20_000);

  it("[SH-098 AC-20] без .env в worktree берётся .env основной папки, он важнее окружения процесса", () => {
    const s = happy();
    prepared(s);
    writeFileSync(join(s.work, ".env"), "POSTGRES_PORT=5434\n");

    runFactory(s, s.work, ["run", "SH-901"], { env: { POSTGRES_PORT: "5111" } });

    expect(claudeCalls(s)[0]?.env.POSTGRES_PORT).toBe("5434");
  }, 20_000);
});

describe("factory-tools: правила воркера", () => {
  it("[SH-098 AC-6] Bash(ls:*) подходит к ls и ls -la, не подходит к lsof; Read подходит к инструменту Read", async () => {
    const { matchesRule } = await factoryTools();

    expect(matchesRule("Bash(ls:*)", "ls")).toBe(true);
    expect(matchesRule("Bash(ls:*)", "ls -la")).toBe(true);
    expect(matchesRule("Bash(ls:*)", "lsof")).toBe(false);
    expect(matchesRule("Bash(git commit:*)", "git commit -m x")).toBe(true);
    expect(matchesRule("Bash(git commit:*)", "git commit")).toBe(true);
    expect(matchesRule("Bash(git commit:*)", "git commit-tree")).toBe(false);
    expect(matchesRule("Read", "Read")).toBe(true);
    expect(matchesRule("Read", "Edit")).toBe(false);
    expect(matchesRule("Read", "ls")).toBe(false);
  });

  it("[SH-098 AC-7] запрещённые команды подходят к --disallowedTools и не подходят к разрешённым правилам", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of ["git push origin x", "gh pr create", "curl x", "rm -rf x"]) {
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в запретах`,
      ).toBe(true);
      expect(
        WORKER_ALLOWED.filter((rule) => matchesRule(rule, command)),
        `${command}: подходит к разрешённому`,
      ).toEqual([]);
    }
  });

  it("[SH-098 AC-8] нужные команды воркера подходят к разрешённым правилам и не подходят к запретам", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED, workerAllowed } = await factoryTools();

    for (const command of [
      "git commit -m x",
      "pnpm verify",
      "node scripts/task.mjs SH-1",
      "backlog task edit SH-1 --check-ac 1",
      "tail -n 40",
      "git fetch origin",
      "git status --short",
      "git log --oneline origin/main..HEAD",
      "node scripts/doc.mjs td 4.1",
      "docker compose up -d",
    ]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(WORKER_DISALLOWED.some((rule) => matchesRule(rule, command))).toBe(false);
    }
    // Файловые инструменты разрешены только внутри worktree (замечание ревью): список строится на запуск.
    const allowed = workerAllowed(workDir);
    for (const name of ["Read", "Edit", "Write", "Grep", "Glob"]) {
      expect(
        allowed.some((rule) => rule.startsWith(`${name}(//`)),
        `${name}: нет правила с путём`,
      ).toBe(true);
      expect(allowed).not.toContain(name);
    }
  });

  it("[SH-098 AC-5] лимит бюджета — положительное число, правила без запятых внутри", async () => {
    const { WORKER_BUDGET_USD, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    expect(Number.isFinite(WORKER_BUDGET_USD)).toBe(true);
    expect(WORKER_BUDGET_USD).toBeGreaterThan(0);
    for (const rule of [...WORKER_ALLOWED, ...WORKER_DISALLOWED]) expect(rule).not.toContain(",");
  });
});

describe("factory-tools и запуск: замечания ревью SH-098", () => {
  const SECRET_READS = [
    "cat .env",
    "cat ./.env",
    "tail -n 3 .env",
    "head -n 1 ./.env",
    "grep SECRET /work/wt/.env",
    "grep SECRET .env.local",
    "grep -r SECRET .",
    "grep -rn SECRET .",
    "grep SECRET -r .",
    "grep -R SECRET .",
    "grep SECRET --recursive .",
  ];

  it("[SH-098 AC-7] pnpm exec и pnpm dlx не обходят запреты на push и curl", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of [
      "pnpm exec git push origin x",
      "pnpm exec curl x",
      "pnpm exec gh pr create",
      "pnpm dlx cowsay hi",
    ]) {
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в запретах`,
      ).toBe(true);
      expect(WORKER_ALLOWED.filter((rule) => matchesRule(rule, command))).toEqual([]);
    }
    for (const command of [
      "pnpm exec node -e 1",
      "pnpm exec sh -c x",
      "pnpm run anything",
      "pnpm add left-pad",
      "pnpm publish",
    ]) {
      expect(
        WORKER_ALLOWED.filter((rule) => matchesRule(rule, command)),
        `${command}: подходит к разрешённому`,
      ).toEqual([]);
    }
  });

  it("[SH-098 AC-8] скрипты pnpm и инструменты проверки из sh-worker.md разрешены", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of [
      "pnpm verify",
      "pnpm check",
      "pnpm test",
      "pnpm test:api",
      "pnpm exec vitest run --reporter=minimal tools/tests/factory.test.ts",
      "pnpm install --frozen-lockfile",
    ]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(WORKER_DISALLOWED.some((rule) => matchesRule(rule, command))).toBe(false);
    }
  });

  it("[SH-098 AC-7] чтение .env командами Bash запрещено, cat не разрешён", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of SECRET_READS) {
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в запретах`,
      ).toBe(true);
    }
    expect(WORKER_ALLOWED.some((rule) => matchesRule(rule, "cat a.txt"))).toBe(false);
    expect(WORKER_DISALLOWED).toEqual(
      expect.arrayContaining(["Read(**/.env)", "Edit(**/.env)", "Read(**/.env.local)"]),
    );
    expect(WORKER_DISALLOWED).not.toContain("Read(**/.env.example)");
  });

  it("[SH-098 AC-8] tail, head и wc после pipe остаются разрешёнными", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of ["tail -n 40", "head -n 5", "wc -l"]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        command,
      ).toBe(true);
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        command,
      ).toBe(false);
    }
  });

  it("[SH-098 AC-5] workerAllowed(worktree): Read, Edit, Write, Grep и Glob только внутри worktree", async () => {
    const { workerAllowed, worktreeGlob } = await factoryTools();
    const worktree = join(workDir, "правила-путей");
    mkdirSync(worktree, { recursive: true });

    const allowed = workerAllowed(worktree);

    const glob = worktreeGlob(worktree);
    expect(glob).toBe(`/${worktree}/**`);
    for (const name of ["Read", "Edit", "Write", "Grep", "Glob"]) {
      expect(allowed).toContain(`${name}(${glob})`);
      expect(allowed).not.toContain(name);
    }
    expect(allowed.filter((rule) => /^(Read|Edit|Write|Grep|Glob)\(/.test(rule))).toHaveLength(5);
    expect(() => workerAllowed(join(workDir, "с,запятой"))).toThrow(/запят/);
  });

  it("[SH-098 AC-5] бюджет и таймаут: значения по умолчанию и переопределение окружением", async () => {
    const { WORKER_BUDGET_USD, WORKER_TIMEOUT_MIN, workerBudgetUsd, workerTimeoutMs } = await factoryTools();

    expect(workerBudgetUsd({})).toBe(WORKER_BUDGET_USD);
    expect(workerBudgetUsd({ FACTORY_WORKER_BUDGET_USD: "2.5" })).toBe(2.5);
    expect(workerTimeoutMs({})).toBe(WORKER_TIMEOUT_MIN * 60_000);
    expect(workerTimeoutMs({ FACTORY_WORKER_TIMEOUT_MIN: "0.5" })).toBe(30_000);
    for (const bad of ["abc", "0", "-1", "NaN"]) {
      expect(() => workerBudgetUsd({ FACTORY_WORKER_BUDGET_USD: bad }), bad).toThrow(/FACTORY_WORKER_BUDGET_USD/);
      expect(() => workerTimeoutMs({ FACTORY_WORKER_TIMEOUT_MIN: bad }), bad).toThrow(/FACTORY_WORKER_TIMEOUT_MIN/);
    }
  });

  it("[SH-098 AC-5] FACTORY_WORKER_BUDGET_USD попадает в --max-budget-usd", () => {
    const s = happy();
    prepared(s);

    runFactory(s, s.work, ["run", "SH-901", "--foreground"], { env: { FACTORY_WORKER_BUDGET_USD: "2.5" } });

    expect(flagValue(claudeCalls(s)[0] as ClaudeCall, "--max-budget-usd")).toBe("2.5");
  }, 20_000);

  it("[SH-098 AC-5] таймаут claude: этап «ошибка» с причиной, pid очищен", () => {
    const s = happy();
    prepared(s);

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], {
      env: { FAKE_CLAUDE_SLEEP: "20000", FACTORY_WORKER_TIMEOUT_MIN: "0.03" },
    });

    expect(code).toBe(0);
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ stage: "ошибка", pid: null, pid_started_at: "" });
    expect(task?.reason).toMatch(/таймаут/);
  }, 30_000);

  it.each(["в работе", "готово", "стоп", "ошибка"])(
    "[SH-098 AC-4] _worker на записи с этапом «%s»: отказ, код 1, claude не вызван, запись не изменена",
    (stage) => {
      const s = happy();
      prepared(s);
      nodeEval(s.work, `m.setStage("SH-901", ${JSON.stringify(stage)}, "тест");`);
      const before = snapshot(s);

      const { code, out } = runFactory(s, s.work, ["_worker", "SH-901"]);

      expect(code).toBe(1);
      expect(out).toContain(`этап «${stage}»`);
      expect(claudeCalls(s)).toHaveLength(0);
      expect(snapshot(s).state).toEqual(before.state);
    },
    20_000,
  );

  it("[SH-098 AC-4] _worker на записи «подготовлена» с живым pid: отказ, claude не вызван", async () => {
    const s = happy();
    const live = await liveProcess();
    prepared(
      s,
      "SH-901",
      TITLE_FABRIKA,
      BRANCH_901,
      `, pid: ${live.pid}, pid_started_at: ${JSON.stringify(live.startedAt)}`,
    );

    const { code, out } = runFactory(s, s.work, ["_worker", "SH-901"], { settle: false });

    expect(code).toBe(1);
    expect(out).toContain("живой процесс");
    expect(claudeCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("подготовлена");
  }, 20_000);

  it("[SH-098 AC-16] _worker при двух чужих живых процессах: отказ, код 1, claude не вызван", async () => {
    const s = happy();
    prepared(s);
    const a = await liveProcess();
    const b = await liveProcess();
    const live = (id: string, p: { pid: number; startedAt: string }) =>
      `m.createTask(${JSON.stringify(id)}, { title: "Живая", branch: "sh-x", worktree: "/x", stage: "в работе", pid: ${p.pid}, pid_started_at: ${JSON.stringify(p.startedAt)} });`;
    expect(nodeEval(s.work, `${live("SH-902", a)}${live("SH-903", b)}`).code).toBe(0);

    const { code, out } = runFactory(s, s.work, ["_worker", "SH-901"], { settle: false });

    expect(code).toBe(1);
    expect(out).toContain("SH-902");
    expect(out).toContain("SH-903");
    expect(claudeCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("подготовлена");
  }, 20_000);

  it("[SH-098 AC-16] два _worker одновременно при одном чужом живом процессе: claude запускает один", async () => {
    const s = happy();
    prepared(s);
    prepared(s, "SH-902", TITLE_FABRIKA, "sh-902-second");
    const other = await liveProcess();
    expect(
      nodeEval(
        s.work,
        `m.createTask("SH-903", { title: "Живая", branch: "sh-x", worktree: "/x", stage: "в работе", pid: ${other.pid}, pid_started_at: ${JSON.stringify(other.startedAt)} });`,
      ).code,
    ).toBe(0);
    writeFileSync(s.log, "");
    writeFileSync(`${s.log}.claude`, "");
    const start = (id: string) =>
      new Promise<number | null>((done) => {
        const child = spawn(process.execPath, [script, "_worker", id], {
          cwd: s.work,
          stdio: "ignore",
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: s.log, ...SLOW },
        });
        child.once("exit", done);
      });

    const codes = await Promise.all([start("SH-901"), start("SH-902")]);

    expect([...codes].sort()).toEqual([0, 1]);
    expect(claudeCalls(s)).toHaveLength(1);
    expect(waitUntil(() => pidRecords(s).join() === "SH-903")).toBe(true);
  }, 30_000);
});

describe("factory: parseWorkerReply", () => {
  const ID = "SH-098";
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ГОТОВО SH-098",
      session_id: SESSION,
      total_cost_usd: 0.3,
      permission_denials: [],
      ...over,
    });

  type Row = { name: string; input: Record<string, unknown>; stage: string; reason: string };
  const rows: Row[] = [
    { name: "ГОТОВО SH-NNN", input: { stdout: body() }, stage: "готово", reason: "" },
    {
      name: "первая непустая строка после обрезки пробелов",
      input: { stdout: body({ result: "\n  ГОТОВО SH-098  \nдальше текст" }) },
      stage: "готово",
      reason: "",
    },
    {
      name: "СТОП SH-NNN: x",
      input: { stdout: body({ result: "СТОП SH-098: x\nВопрос владельцу: y" }) },
      stage: "стоп",
      reason: "СТОП SH-098: x",
    },
    { name: "ГОТОВО и код 1", input: { stdout: body(), code: 1 }, stage: "ошибка", reason: "код 1" },
    { name: "ГОТОВО и is_error", input: { stdout: body({ is_error: true }) }, stage: "ошибка", reason: "is_error" },
    {
      name: "is_error раньше кода",
      input: { stdout: body({ is_error: true }), code: 1 },
      stage: "ошибка",
      reason: "is_error",
    },
    {
      name: "subtype ошибки раньше is_error",
      input: { stdout: body({ subtype: "error_during_execution", is_error: true }), code: 1 },
      stage: "ошибка",
      reason: "ошибка claude: error_during_execution",
    },
    {
      name: "чужой ID у ГОТОВО",
      input: { stdout: body({ result: "ГОТОВО SH-0980" }) },
      stage: "ошибка",
      reason: "чужой ID",
    },
    {
      name: "чужой ID у СТОП",
      input: { stdout: body({ result: "СТОП SH-097: x" }) },
      stage: "ошибка",
      reason: "чужой ID",
    },
    {
      name: "СТОП без двоеточия",
      input: { stdout: body({ result: "СТОП SH-098" }) },
      stage: "ошибка",
      reason: "неизвестный ответ",
    },
    {
      name: "ГОТОВО с хвостом",
      input: { stdout: body({ result: "ГОТОВО SH-098 всё" }) },
      stage: "ошибка",
      reason: "неизвестный ответ",
    },
    {
      name: "другой текст",
      input: { stdout: body({ result: "Сделал всё, что мог." }) },
      stage: "ошибка",
      reason: "неизвестный ответ",
    },
    { name: "пустой result", input: { stdout: body({ result: "" }) }, stage: "ошибка", reason: "неизвестный ответ" },
    { name: "невалидный JSON", input: { stdout: "это не json" }, stage: "ошибка", reason: "невалидный JSON" },
    { name: "пустой stdout", input: { stdout: "" }, stage: "ошибка", reason: "невалидный JSON" },
    {
      name: "невалидный JSON и код 1",
      input: { stdout: "oops", code: 1 },
      stage: "ошибка",
      reason: "невалидный JSON",
    },
    { name: "нет result", input: { stdout: body({ result: undefined }) }, stage: "ошибка", reason: "нет result" },
    {
      name: "ошибка запуска",
      input: { stdout: "", error: "spawn claude ENOENT" },
      stage: "ошибка",
      reason: "claude не запустился: spawn claude ENOENT",
    },
    {
      name: "ошибка запуска как Error",
      input: { stdout: "", error: new Error("spawn claude ENOENT") },
      stage: "ошибка",
      reason: "claude не запустился: spawn claude ENOENT",
    },
    {
      name: "ЗАМЕЧАНИЯ SH-NNN",
      input: { stdout: body({ result: "ЗАМЕЧАНИЯ SH-098\n1. что-то" }) },
      stage: "стоп",
      reason: "ЗАМЕЧАНИЯ SH-098",
    },
    {
      name: "ЗАМЕЧАНИЯ с чужим ID",
      input: { stdout: body({ result: "ЗАМЕЧАНИЯ SH-0980" }) },
      stage: "ошибка",
      reason: "чужой ID",
    },
  ];

  it.each(rows)("[SH-098 AC-9] $name → $stage", async ({ input, stage, reason }) => {
    const { parseWorkerReply } = await factoryModule();

    const reply = parseWorkerReply({ taskId: ID, sessionId: SESSION, ...input } as never);

    expect(reply.stage).toBe(stage);
    expect(reply.reason).toBe(reason);
  });

  it("[SH-098 AC-21] ЗАМЕЧАНИЯ SH-NNN → стоп с этой строкой в reason; ЗАМЕЧАНИЯ SH-0980 → чужой ID", async () => {
    const { parseWorkerReply } = await factoryModule();

    expect(
      parseWorkerReply({ stdout: body({ result: "ЗАМЕЧАНИЯ SH-098" }), code: 0, taskId: ID, sessionId: SESSION }),
    ).toMatchObject({
      stage: "стоп",
      reason: "ЗАМЕЧАНИЯ SH-098",
    });
    expect(
      parseWorkerReply({ stdout: body({ result: "ЗАМЕЧАНИЯ SH-0980" }), code: 0, taskId: ID, sessionId: SESSION }),
    ).toMatchObject({
      stage: "ошибка",
      reason: "чужой ID",
    });
  });

  it("[SH-098 AC-9] без валидного JSON: cost 0, denials [], sessionReady false", async () => {
    const { parseWorkerReply } = await factoryModule();

    for (const input of [
      { stdout: "не json", code: 0 },
      { stdout: "", error: "spawn claude ENOENT" },
    ]) {
      expect(parseWorkerReply({ taskId: ID, sessionId: SESSION, ...input })).toMatchObject({
        cost: 0,
        denials: [],
        sessionReady: false,
      });
    }
  });

  it("[SH-098 AC-9] стоимость и отказы берутся из валидного JSON при любой причине ошибки", async () => {
    const { parseWorkerReply } = await factoryModule();
    const denials = [{ tool_name: "Bash", tool_input: { command: "curl x" } }];

    const reply = parseWorkerReply({
      stdout: body({ is_error: true, total_cost_usd: 0.7, permission_denials: denials }),
      code: 1,
      taskId: ID,
      sessionId: SESSION,
    });

    expect(reply).toMatchObject({ stage: "ошибка", reason: "is_error", cost: 0.7, denials });
  });

  it("[SH-098 AC-10] превышение бюджета: «ошибка claude: error_max_budget_usd» и стоимость из ответа", async () => {
    const { parseWorkerReply } = await factoryModule();
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      duration_ms: 91234,
      is_error: true,
      num_turns: 14,
      session_id: SESSION,
      total_cost_usd: 5.0213,
      usage: { input_tokens: 10 },
      permission_denials: [],
      errors: ["Reached maximum budget ($5)"],
    });

    const reply = parseWorkerReply({ stdout, code: 1, taskId: ID, sessionId: SESSION });

    expect(reply).toMatchObject({ stage: "ошибка", reason: "ошибка claude: error_max_budget_usd", cost: 5.0213 });
  });

  it("[SH-098 AC-13] sessionReady true при совпадении session_id с sessionId, false при другом", async () => {
    const { parseWorkerReply } = await factoryModule();

    expect(parseWorkerReply({ stdout: body(), code: 0, taskId: ID, sessionId: SESSION }).sessionReady).toBe(true);
    expect(parseWorkerReply({ stdout: body(), code: 0, taskId: ID, sessionId: "другой" }).sessionReady).toBe(false);
    expect(
      parseWorkerReply({ stdout: body({ session_id: undefined }), code: 0, taskId: ID, sessionId: SESSION })
        .sessionReady,
    ).toBe(false);
  });
});

describe("factory: applyWorkerReply и saveReply", () => {
  const seed = (extra = "") =>
    `m.createTask("SH-950", { title: "Т", branch: "sh-950-t", worktree: "/w", stage: "в работе", cost_usd: 0.4, pid: 4242, pid_started_at: "2026-01-01T00:00:00.000Z"${extra} });`;

  it("[SH-098 AC-11] cost_usd 0.40 + 0.25 = 0.65, этап и reason из ответа, pid не тронут, в том числе при is_error", () => {
    const s = happy();

    const { code, out, err } = nodeEvalAll(
      s.work,
      `${seed()}
       f.applyWorkerReply("SH-950", { stage: "ошибка", reason: "is_error", cost: 0.25, denials: [], sessionReady: false });
       console.log(JSON.stringify(m.readState().tasks["SH-950"]));`,
    );

    expect(code, err).toBe(0);
    const task = JSON.parse(out);
    expect(task.cost_usd).toBeCloseTo(0.65);
    expect(task).toMatchObject({
      stage: "ошибка",
      reason: "is_error",
      pid: 4242,
      pid_started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(readFileSync(join(s.stateDir, "SH-950/log.txt"), "utf8")).toMatch(/этап: в работе → ошибка; is_error/);
  });

  it("[SH-098 AC-12] denials из ответа как есть; без поля — пустой массив", () => {
    const s = happy();
    const denials = [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "curl -I example.com" } }];

    const { code, out, err } = nodeEvalAll(
      s.work,
      `${seed(", denials: [{ old: true }]")}
       f.applyWorkerReply("SH-950", { stage: "стоп", reason: "СТОП SH-950: x", cost: 0, denials: ${JSON.stringify(denials)}, sessionReady: false });
       const first = m.readState().tasks["SH-950"].denials;
       f.applyWorkerReply("SH-950", { stage: "стоп", reason: "СТОП SH-950: x", cost: 0, sessionReady: false });
       console.log(JSON.stringify({ first, second: m.readState().tasks["SH-950"].denials }));`,
    );

    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ first: denials, second: [] });
  });

  it("[SH-098 AC-13] sessionReady true ставит session_ready, false не сбрасывает true", () => {
    const s = happy();

    const { code, out, err } = nodeEvalAll(
      s.work,
      `${seed()}
       const reply = { stage: "готово", reason: "", cost: 0, denials: [] };
       const seen = [m.readState().tasks["SH-950"].session_ready];
       f.applyWorkerReply("SH-950", { ...reply, sessionReady: false });
       seen.push(m.readState().tasks["SH-950"].session_ready);
       f.applyWorkerReply("SH-950", { ...reply, sessionReady: true });
       seen.push(m.readState().tasks["SH-950"].session_ready);
       f.applyWorkerReply("SH-950", { ...reply, sessionReady: false });
       seen.push(m.readState().tasks["SH-950"].session_ready);
       console.log(JSON.stringify(seen));`,
    );

    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual([false, false, true, true]);
  });

  it("[SH-098 AC-14] saveReply: 001-worker.json, 002-worker.json, 003-worker.json, невалидный stdout как есть", () => {
    const s = happy();

    const { code, err } = nodeEvalAll(
      s.work,
      `f.saveReply("SH-950", "worker", '{"result":"один"}');
       f.saveReply("SH-950", "worker", "это не json {");
       f.saveReply("SH-950", "worker", "");`,
    );

    expect(code, err).toBe(0);
    const dir = join(s.stateDir, "SH-950");
    expect(readFileSync(join(dir, "001-worker.json"), "utf8")).toBe('{"result":"один"}');
    expect(readFileSync(join(dir, "002-worker.json"), "utf8")).toBe("это не json {");
    expect(readFileSync(join(dir, "003-worker.json"), "utf8")).toBe("");
    expect(existsSync(join(dir, "004-worker.json"))).toBe(false);
  });

  it("[SH-098 AC-14] при файлах 001-… и 003-… следующий — 004-worker.json, роль verifier даёт свой суффикс", () => {
    const s = happy();
    mkdirSync(join(s.stateDir, "SH-950"), { recursive: true });
    writeFileSync(join(s.stateDir, "SH-950/001-worker.json"), "{}");
    writeFileSync(join(s.stateDir, "SH-950/003-verifier.json"), "{}");

    const { code, err } = nodeEvalAll(
      s.work,
      `f.saveReply("SH-950", "worker", "новый");
       f.saveReply("SH-950", "verifier", "ещё");`,
    );

    expect(code, err).toBe(0);
    expect(readFileSync(join(s.stateDir, "SH-950/004-worker.json"), "utf8")).toBe("новый");
    expect(readFileSync(join(s.stateDir, "SH-950/005-verifier.json"), "utf8")).toBe("ещё");
  });
});

describe("factory: не больше двух живых фоновых процессов", () => {
  const withPids = (id: string, pid: number, startedAt: string) =>
    `m.createTask(${JSON.stringify(id)}, { title: "Живая", branch: "sh-x", worktree: "/x", stage: "в работе", pid: ${pid}, pid_started_at: ${JSON.stringify(startedAt)} });`;

  it("[SH-098 AC-16] isAlive: живой pid с совпадающим временем старта — да; чужое время, мёртвый pid и пустой pid — нет", async () => {
    const { isAlive } = await factoryModule();
    const live = await liveProcess();

    expect(isAlive({ pid: live.pid, pid_started_at: live.startedAt })).toBe(true);
    expect(isAlive({ pid: live.pid, pid_started_at: "2001-01-01T00:00:00.000Z" })).toBe(false);
    expect(isAlive({ pid: 4_000_000, pid_started_at: live.startedAt })).toBe(false);
    expect(isAlive({ pid: null, pid_started_at: "" })).toBe(false);
    expect(isAlive({ pid: live.pid, pid_started_at: "" })).toBe(false);
  });

  it("[SH-098 AC-16] две задачи с живым pid: отказ, код 1, их ID, ничего не создано", async () => {
    const s = happy();
    const a = await liveProcess();
    const b = await liveProcess();
    const seeded = nodeEvalAll(
      s.work,
      `${withPids("SH-902", a.pid, a.startedAt)}${withPids("SH-903", b.pid, b.startedAt)}`,
    );
    expect(seeded.code, seeded.err).toBe(0);
    const before = snapshot(s);

    for (const args of [["run", "SH-901"], ["run"]]) {
      const { code, out } = runFactory(s, s.work, args, { settle: false });

      expect(code).toBe(1);
      expect(out).toContain("SH-902");
      expect(out).toContain("SH-903");
      expect(snapshot(s)).toEqual(before);
      expect(claudeCalls(s)).toHaveLength(0);
    }
  });

  it("[SH-098 AC-16] живой, мёртвый pid и pid с другим временем старта: живой один, запуск проходит", async () => {
    const s = happy();
    const a = await liveProcess();
    const b = await liveProcess();
    const seeded = nodeEvalAll(
      s.work,
      `${withPids("SH-902", a.pid, a.startedAt)}${withPids("SH-903", 4000000, a.startedAt)}${withPids("SH-904", b.pid, "2001-01-01T00:00:00.000Z")}`,
    );
    expect(seeded.code, seeded.err).toBe(0);

    const { code } = runFactory(s, s.work, ["run", "SH-901"], { settle: false });

    expect(code).toBe(0);
    expect(waitUntil(() => readTasks(s)["SH-901"]?.pid === null && readTasks(s)["SH-901"]?.stage === "стоп")).toBe(
      true,
    );
    expect(branchesOf(s.work)).toContain(BRANCH_901);
  }, 20_000);
});

describe("local-env: общий список переменных", () => {
  it("[SH-098 AC-20] local-env.mjs экспортирует ALLOWED и readLocalEnv; читает только переменные из списка", async () => {
    const { ALLOWED, readLocalEnv } = await import("../../scripts/lib/local-env.mjs");
    const dir = join(workDir, "local-env-case");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".env"),
      '# локально\nPOSTGRES_PORT="5434" # порт\nexport DATABASE_URL=postgres://u:p@h:5434/db # dev\nTEST_DATABASE_URL=postgres://u:p@h:5434/db_test\nNODE_ENV=development\nS3_SECRET_ACCESS_KEY=секрет\n',
    );

    expect(ALLOWED).toEqual(["POSTGRES_PORT", "DATABASE_URL", "TEST_DATABASE_URL"]);
    expect(readLocalEnv(dir)).toEqual({
      POSTGRES_PORT: "5434",
      DATABASE_URL: "postgres://u:p@h:5434/db",
      TEST_DATABASE_URL: "postgres://u:p@h:5434/db_test",
    });
    expect(readLocalEnv(join(workDir, "нет-такой-папки"))).toEqual({});
  });

  it("[SH-098 AC-20] хук session-env.mjs импортирует local-env.mjs внутри try и не объявляет свой список", () => {
    const hook = readFileSync(join(repoRoot, "scripts/hooks/session-env.mjs"), "utf8");

    expect(hook).toContain("lib/local-env.mjs");
    expect(hook).not.toMatch(/\bALLOWED\s*=/);
    expect(hook).not.toContain("POSTGRES_PORT");
    const tryIndex = hook.indexOf("try {", hook.indexOf("mainRoot"));
    expect(hook.indexOf("lib/local-env.mjs")).toBeGreaterThan(tryIndex);
  });
});
