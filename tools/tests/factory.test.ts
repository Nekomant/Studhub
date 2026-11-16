import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
// SH-094: `osascript` подменяется скриптом в PATH (журнал `<FAKE_LOG>.osa`), AC-12 ручной, AC-14 проверяется в ревью.

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

// Подставной pnpm: пишет `pnpm <аргументы> cwd=<папка>` в журнал FAKE_LOG.
// С FAKE_PNPM_FAIL (любая команда) или FAKE_PNPM_FAIL_MATCH (команда с подстрокой) печатает
// FAKE_PNPM_FAIL_OUTPUT (по умолчанию 25 строк «install-line …») и завершается с кодом 1.
const fakeBin = join(workDir, "bin");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, "pnpm"),
  `#!/bin/sh
echo "pnpm $* cwd=$PWD" >> "$FAKE_LOG"
fail=0
if [ -n "$FAKE_PNPM_FAIL" ]; then fail=1; fi
if [ -n "$FAKE_PNPM_FAIL_MATCH" ] && echo " $* " | grep -q "$FAKE_PNPM_FAIL_MATCH"; then fail=1; fi
if [ "$fail" = "1" ]; then
  if [ -n "$FAKE_PNPM_FAIL_OUTPUT" ]; then
    printf '%s\n' "$FAKE_PNPM_FAIL_OUTPUT"
  else
    i=1
    while [ $i -le 25 ]; do echo "install-line $i"; i=$((i + 1)); done
  fi
  exit 1
fi
echo '{}'
`,
);
chmodSync(join(fakeBin, "pnpm"), 0o755);

// Подставной gh: пишет `gh <аргументы> cwd=<папка>` в журнал FAKE_LOG.
// `pr create` печатает FAKE_GH_PR_URL, `pr checks`/`pr view` — FAKE_GH_CHECKS (по умолчанию SUCCESS),
// `pr merge` имитирует squash-слияние: переводит origin/main на пушнутую ветку задачи.
writeFileSync(
  join(fakeBin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, "gh " + a.join(" ") + " cwd=" + process.cwd() + "\\n");
const pair = (a[0] ?? "") + " " + (a[1] ?? "");
const exit = Number(process.env.FAKE_GH_EXIT ?? 0);
if (pair === "pr create") {
  process.stdout.write(process.env.FAKE_GH_PR_URL ?? "https://github.com/x/y/pull/1");
  process.exitCode = exit;
} else if (pair === "pr checks" || pair === "pr view") {
  process.stdout.write(process.env.FAKE_GH_CHECKS ?? '{"state":"SUCCESS"}');
  process.exitCode = exit;
} else if (pair === "pr merge") {
  cp.execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], { stdio: "ignore" });
  process.exitCode = exit;
} else {
  process.stdout.write("{}");
}
`,
);
chmodSync(join(fakeBin, "gh"), 0o755);

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
  session_id: env.FAKE_CLAUDE_SESSION === "same" ? after("--session-id") || after("--resume") : "other-session",
  total_cost_usd: Number(env.FAKE_CLAUDE_COST ?? 0),
  permission_denials: [],
};
process.stdout.write(env.FAKE_CLAUDE_RAW ?? JSON.stringify(reply));
process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 0);
`,
);
chmodSync(join(fakeBin, "claude"), 0o755);

// Подставной osascript (SH-094): строка JSON со списком аргументов в `<FAKE_LOG>.osa`.
// С FAKE_OSASCRIPT_FAIL завершается с кодом 1.
writeFileSync(
  join(fakeBin, "osascript"),
  `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_LOG + ".osa", JSON.stringify(process.argv.slice(2)) + "\\n");
process.exitCode = process.env.FAKE_OSASCRIPT_FAIL ? 1 : 0;
`,
);
chmodSync(join(fakeBin, "osascript"), 0o755);

// Подставной dsh (SH-107): строка JSON `{ args, cwd, env }` в `<FAKE_LOG>.dsh`, затем ответ.
// Ответ по умолчанию — валидный JSON с result «чисто» и usage 0. Настройка: FAKE_DSH_RESULT (текст result),
// FAKE_DSH_RAW (stdout как есть), FAKE_DSH_EXIT (код), FAKE_DSH_SESSION=same (session_id из --session-id),
// FAKE_DSH_INPUT / FAKE_DSH_OUTPUT / FAKE_DSH_REASONING (токены usage), FAKE_DSH_SLEEP (мс до ответа).
writeFileSync(
  join(fakeBin, "dsh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.FAKE_LOG + ".dsh", JSON.stringify({ args, cwd: process.cwd(), env }) + "\\n");
if (env.FAKE_DSH_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_DSH_SLEEP));
const after = (flag) => args[args.indexOf(flag) + 1] ?? "";
// Воркер по умолчанию возвращает «СТОП <id>: заглушка» (как старая заглушка claude), остальные роли — «чисто».
const worker = String(args[args.length - 1] ?? "").includes("sh-worker");
const id = /SH-\\d+/.exec(args.join(" "))?.[0] ?? "SH-0";
const reply = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: env.FAKE_DSH_RESULT ?? (worker ? "СТОП " + id + ": заглушка" : "чисто"),
  session_id: env.FAKE_DSH_SESSION === "same" ? after("--session-id") : "other-session",
  usage: {
    input_tokens: Number(env.FAKE_DSH_INPUT ?? 0),
    output_tokens: Number(env.FAKE_DSH_OUTPUT ?? 0),
    reasoning_tokens: Number(env.FAKE_DSH_REASONING ?? 0),
  },
};
process.stdout.write(env.FAKE_DSH_RAW ?? JSON.stringify(reply));
process.exitCode = Number(env.FAKE_DSH_EXIT ?? 0);
`,
);
chmodSync(join(fakeBin, "dsh"), 0o755);

type FixtureTask = {
  id: string;
  title?: string;
  status?: string;
  deps?: string[];
  priority?: string;
  criteria?: number;
  // Спецификация без раздела «Зачем»: check-spec.mjs отвечает ошибкой.
  broken?: boolean;
  // SH-107: поля «Права» (известные значения, например docker), «Затрагивает» (файлы/документы) и «Модель» (pro/flash).
  rights?: string[];
  affects?: string[];
  model?: string;
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
  const rights = task.rights?.length ? `\nrights:\n${task.rights.map((r) => `  - ${r}`).join("\n")}` : "";
  const affects = task.affects?.length ? `\naffects:\n${task.affects.map((a) => `  - ${a}`).join("\n")}` : "";
  const model = task.model ? `\nmodel: ${task.model}` : "";
  return `---
id: ${task.id}
title: ${JSON.stringify(task.title ?? `Задача ${task.id.slice(3)}`)}
status: ${task.status ?? "Ready"}
assignee: []
labels: []
dependencies:${deps}
priority: ${task.priority ?? "medium"}${rights}${affects}${model}
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
  // Фабрика коммитит сама (appendRetroEntry, commitMergedStatus) через git без -c: в CI глобальной
  // идентичности нет, поэтому задаём её в конфиге клона, который наследуют worktree.
  git(work, "config", "user.name", "t");
  git(work, "config", "user.email", "t@example.com");

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
  writeFileSync(`${scenario.log}.osa`, "");
  writeFileSync(`${scenario.log}.dsh`, "");
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

type DshCall = { args: string[]; cwd: string; env: Record<string, string> };

// Вызовы заглушки dsh с начала последнего runFactory (SH-107).
const dshCalls = (scenario: Scenario): DshCall[] =>
  readFileSync(`${scenario.log}.dsh`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// Значение флага в аргументах dsh.
const dshFlag = (call: DshCall, flag: string) => call.args[call.args.indexOf(flag) + 1];

// check-spec.mjs (SH-107 AC-11): проверка полей «Права»/«Затрагивает»/«Модель» на фикстуре через --root.
const checkSpecScript = join(repoRoot, "scripts/check-spec.mjs");
function runCheckSpec(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [checkSpecScript, ...args, "--root", root], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
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
    // Этап не «в работе»: у такой записи без живого процесса SH-094 AC-11 меняет этап на «ошибка».
    seedRecord(s, "SH-906", "стоп");
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
      reason: /этапе «стоп»/,
      setup: (s) => seedRecord(s, "SH-906", "стоп"),
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
      "проверки DoD",
      "красный коммит",
      "ревью",
      "готов к ревью",
      "CI",
      "Merged",
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
const SLOW = { FAKE_DSH_SLEEP: "2500" };

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
  // Как `factory ready`: ветка берётся от свежего origin/main, а не от устаревшей локальной ссылки.
  git(s.work, "fetch", "-q", "origin", "main");
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
  it("[SH-098 AC-1] без --foreground: этап «в работе» с pid и временем старта, код 0 до ответа dsh", async () => {
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
    expect(dshFlag(dshCalls(s)[0]!, "--session-id")).toBe(readTasks(s)["SH-901"]?.session_id);
  }, 20_000);

  it("[SH-098 AC-3] --foreground: pid и время старта текущего процесса, команда ждёт ответа dsh", async () => {
    const s = happy();
    prepared(s);
    writeFileSync(s.log, "");
    writeFileSync(`${s.log}.dsh`, "");
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

  it("[SH-098 AC-15] --foreground на заглушке: 001-worker.json, этап, reason, токены, строка dsh в журнале, pid очищен", () => {
    const s = happy();
    prepared(s);

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], {
      env: { FAKE_DSH_INPUT: "25", FAKE_DSH_OUTPUT: "5" },
    });

    expect(code).toBe(0);
    const reply = JSON.parse(readFileSync(join(s.stateDir, "SH-901/001-worker.json"), "utf8"));
    expect(reply.result).toBe("СТОП SH-901: заглушка");
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ stage: "стоп", reason: "СТОП SH-901: заглушка", pid: null, pid_started_at: "" });
    expect((task?.tokens as { worker?: unknown } | undefined)?.worker).toMatchObject({ input: 25, output: 5 });
    const log = logOf(s, "SH-901");
    expect(log).toMatch(/dsh headless .*sh-worker/);
    expect(log).toMatch(/этап: подготовлена → в работе/);
    expect(log).toMatch(/этап: в работе → стоп; СТОП SH-901: заглушка/);
  }, 20_000);

  it("[SH-098 AC-15] быстрый ответ заглушки не обгоняет запись этапа «в работе»: в журнале «в работе» раньше «готово»", () => {
    const s = happy();
    prepared(s);

    runFactory(s, s.work, ["run", "SH-901"], { env: { FAKE_DSH_RESULT: "ГОТОВО SH-901" } });

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
    expect(dshCalls(s)).toHaveLength(1);
    expect(calls).not.toContain("pnpm");
    expect(logOf(s, "SH-901")).not.toContain("check-spec");
    expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
  }, 20_000);

  // SH-094 AC-11: «в работе» без живого процесса становится «ошибка», поэтому этап «в работе» проверяется отдельно.
  it.each(["готово", "стоп", "ошибка"])(
    "[SH-098 AC-4] запись на этапе «%s»: причина, код 1, воркер не запущен",
    (stage) => {
      const s = happy();
      seedRecord(s, "SH-901", stage);
      const before = snapshot(s);

      const { code, out, calls } = runFactory(s, s.work, ["run", "SH-901"]);

      expect(code).toBe(1);
      expect(out).toContain(`этапе «${stage}»`);
      expect(dshCalls(s)).toHaveLength(0);
      expect(calls).not.toContain("pnpm");
      expect(snapshot(s)).toEqual(before);
    },
  );
});

describe("factory: run SH-NNN на этапе «в работе»", () => {
  it("[SH-098 AC-4] запись «в работе» с живым процессом: причина, код 1, воркер не запущен", async () => {
    const s = happy();
    const live = await liveProcess();
    prepared(
      s,
      "SH-901",
      TITLE_FABRIKA,
      BRANCH_901,
      `, stage: "в работе", pid: ${live.pid}, pid_started_at: ${JSON.stringify(live.startedAt)}`,
    );
    const before = snapshot(s);

    const { code, out } = runFactory(s, s.work, ["run", "SH-901"], { settle: false });

    expect(code).toBe(1);
    expect(out).toContain("этапе «в работе»");
    expect(dshCalls(s)).toHaveLength(0);
    expect(snapshot(s)).toEqual(before);
  }, 20_000);
});

describe("factory: команда dsh и окружение", () => {
  it("[SH-098 AC-5] аргументы и cwd вызова dsh, --session-id равен session_id записи", async () => {
    const s = happy();
    const { worktree } = prepared(s);

    runFactory(s, s.work, ["run", "SH-901"]);

    const calls = dshCalls(s);
    expect(calls).toHaveLength(1);
    const sessionId = readTasks(s)["SH-901"]?.session_id;
    expect(sessionId).toMatch(UUID);
    const args = calls[0]!.args;
    expect(args).toContain("headless");
    expect(args).toContain("--json");
    expect(dshFlag(calls[0]!, "--session-id")).toBe(sessionId);
    expect(dshFlag(calls[0]!, "--permission-mode")).toBe("workspace-write");
    expect(dshFlag(calls[0]!, "--model")).toBe("deepseek-v4-pro");
    expect(dshFlag(calls[0]!, "--effort")).toBe("high");
    expect(args.some((arg) => arg.includes("sh-worker"))).toBe(true);
    expect(calls[0]?.cwd).toBe(worktree);
  }, 20_000);

  it("[SH-098 AC-20] dsh получает TEST_DATABASE_URL из .env основной папки, не получает переменные вне ALLOWED", () => {
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

    const env = dshCalls(s)[0]?.env ?? {};
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

    expect(dshCalls(s)[0]?.env.POSTGRES_PORT).toBe("5434");
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

  it("[SH-098 AC-5] таймаут dsh: этап «ошибка» с причиной, pid очищен", () => {
    const s = happy();
    prepared(s);

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], {
      env: { FAKE_DSH_SLEEP: "20000", FACTORY_WORKER_TIMEOUT_MIN: "0.03" },
    });

    expect(code).toBe(0);
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ stage: "ошибка", pid: null, pid_started_at: "" });
    expect(task?.reason).toMatch(/таймаут/);
  }, 30_000);

  it.each(["в работе", "готово", "стоп", "ошибка"])(
    "[SH-098 AC-4] _worker на записи с этапом «%s»: отказ, код 1, dsh не вызван, запись не изменена",
    (stage) => {
      const s = happy();
      prepared(s);
      nodeEval(s.work, `m.setStage("SH-901", ${JSON.stringify(stage)}, "тест");`);
      const before = snapshot(s);

      const { code, out } = runFactory(s, s.work, ["_worker", "SH-901"]);

      expect(code).toBe(1);
      expect(out).toContain(`этап «${stage}»`);
      expect(dshCalls(s)).toHaveLength(0);
      expect(snapshot(s).state).toEqual(before.state);
    },
    20_000,
  );

  it("[SH-098 AC-4] _worker на записи «подготовлена» с живым pid: отказ, dsh не вызван", async () => {
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
    expect(dshCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("подготовлена");
  }, 20_000);

  it("[SH-098 AC-16] _worker при двух чужих живых процессах: отказ, код 1, dsh не вызван", async () => {
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
    expect(dshCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("подготовлена");
  }, 20_000);

  it("[SH-098 AC-16] два _worker одновременно при одном чужом живом процессе: dsh запускает один", async () => {
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
    writeFileSync(`${s.log}.dsh`, "");
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
    expect(dshCalls(s)).toHaveLength(1);
    expect(waitUntil(() => pidRecords(s).join() === "SH-903")).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------
// SH-105: права воркера на docker, git mv/rm/restore и скрипты миграций.

describe("factory-tools: SH-105 docker, git mv/rm/restore и миграции", () => {
  it("[SH-105 AC-1] подкоманды docker build, run, exec, logs, ps, inspect, stop, rm и compose разрешены", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of [
      "docker build -t x .",
      "docker run --rm x true",
      "docker exec x id -u",
      "docker logs x",
      "docker ps -a",
      "docker inspect x",
      "docker stop x",
      "docker rm x",
      "docker compose up -d",
    ]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: подходит к запрету`,
      ).toBe(false);
    }
  });

  it("[SH-105 AC-2] флаги docker с доступом к файлам хозяина и .env подходят к запретам", async () => {
    const { matchesRule, WORKER_DISALLOWED } = await factoryTools();

    for (const command of [
      "docker run -v /tmp:/t x",
      "docker run -v/tmp:/t x",
      "docker run --volume /tmp:/t x",
      "docker run --volumes-from other x",
      "docker run --mount type=bind,src=/,dst=/h x",
      "docker run --privileged x",
      "docker run --env-file=.env x",
      "docker run --env-file .env x",
      "docker run --pid=host x",
      "docker run --pid host x",
      "docker run --cap-add=ALL x",
      "docker run --device /dev/sda x",
    ]) {
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в запретах`,
      ).toBe(true);
    }
    for (const command of ["docker -v", "docker run --pids-limit 100"]) {
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: ошибочно в запретах`,
      ).toBe(false);
    }
  });

  it("[SH-105 AC-3] подкоманды docker cp, save, login, push и system не подходят к разрешённым", async () => {
    const { matchesRule, WORKER_ALLOWED } = await factoryTools();

    for (const command of [
      "docker cp x:/etc/passwd .",
      "docker save x",
      "docker login",
      "docker push x",
      "docker system prune -af",
    ]) {
      expect(
        WORKER_ALLOWED.filter((rule) => matchesRule(rule, command)),
        `${command}: подходит к разрешённому`,
      ).toEqual([]);
    }
  });

  it("[SH-105 AC-4] git mv, git rm и git restore разрешены; git reset, clean и stash не разрешены", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of ["git mv a.ts b.ts", "git rm old.ts", "git restore apps/web/src/main.tsx"]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: подходит к запрету`,
      ).toBe(false);
    }
    for (const command of ["git reset --hard", "git clean -fd", "git stash"]) {
      expect(
        WORKER_ALLOWED.filter((rule) => matchesRule(rule, command)),
        `${command}: подходит к разрешённому`,
      ).toEqual([]);
    }
  });

  it("[SH-105 AC-5] pnpm gen:client:check и четыре формы --filter разрешены; --filter с exec и start нет", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const command of [
      "pnpm gen:client:check",
      "pnpm --filter @studhub/api db:generate",
      "pnpm --filter @studhub/api db:migrate",
      "pnpm --filter @studhub/web build",
      "pnpm --filter @studhub/admin build",
    ]) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: подходит к запрету`,
      ).toBe(false);
    }
    for (const command of ["pnpm --filter @studhub/api exec git push", "pnpm --filter @studhub/api start"]) {
      expect(
        WORKER_ALLOWED.filter((rule) => matchesRule(rule, command)),
        `${command}: подходит к разрешённому`,
      ).toEqual([]);
    }
  });

  it("[SH-105 AC-7] ни одно правило из WORKER_ALLOWED и WORKER_DISALLOWED не содержит запятой", async () => {
    const { WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();

    for (const rule of [...WORKER_ALLOWED, ...WORKER_DISALLOWED]) {
      expect(rule, `${rule}: содержит запятую`).not.toContain(",");
    }
  });
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
      usage: { input_tokens: 3, output_tokens: 2, reasoning_tokens: 1 },
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
      reason: "ошибка dsh: error_during_execution",
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
      input: { stdout: "", error: "spawn dsh ENOENT" },
      stage: "ошибка",
      reason: "dsh не запустился: spawn dsh ENOENT",
    },
    {
      name: "ошибка запуска как Error",
      input: { stdout: "", error: new Error("spawn dsh ENOENT") },
      stage: "ошибка",
      reason: "dsh не запустился: spawn dsh ENOENT",
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

  it("[SH-098 AC-9] без валидного JSON: токены 0, sessionReady false", async () => {
    const { parseWorkerReply } = await factoryModule();

    for (const input of [
      { stdout: "не json", code: 0 },
      { stdout: "", error: "spawn dsh ENOENT" },
    ]) {
      expect(parseWorkerReply({ taskId: ID, sessionId: SESSION, ...input })).toMatchObject({
        tokens: { input: 0, output: 0, reasoning: 0 },
        sessionReady: false,
      });
    }
  });

  it("[SH-098 AC-9] токены берутся из валидного JSON при любой причине ошибки", async () => {
    const { parseWorkerReply } = await factoryModule();

    const reply = parseWorkerReply({
      stdout: body({ is_error: true, usage: { input_tokens: 7, output_tokens: 2, reasoning_tokens: 1 } }),
      code: 1,
      taskId: ID,
      sessionId: SESSION,
    });

    expect(reply).toMatchObject({ stage: "ошибка", reason: "is_error", tokens: { input: 7, output: 2, reasoning: 1 } });
  });

  it("[SH-098 AC-10] превышение бюджета: «ошибка dsh: error_max_budget_usd» и токены из ответа", async () => {
    const { parseWorkerReply } = await factoryModule();
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      duration_ms: 91234,
      is_error: true,
      num_turns: 14,
      session_id: SESSION,
      usage: { input_tokens: 10, output_tokens: 2, reasoning_tokens: 0 },
      errors: ["Reached maximum budget ($5)"],
    });

    const reply = parseWorkerReply({ stdout, code: 1, taskId: ID, sessionId: SESSION });

    expect(reply).toMatchObject({
      stage: "ошибка",
      reason: "ошибка dsh: error_max_budget_usd",
      tokens: { input: 10, output: 2, reasoning: 0 },
    });
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
    `m.createTask("SH-950", { title: "Т", branch: "sh-950-t", worktree: "/w", stage: "в работе", pid: 4242, pid_started_at: "2026-01-01T00:00:00.000Z"${extra} });`;

  it("[SH-098 AC-11, AC-12] applyWorkerReply: токены воркера накапливаются, этап и reason из ответа, pid не тронут, в том числе при is_error", () => {
    const s = happy();

    const { code, out, err } = nodeEvalAll(
      s.work,
      `${seed()}
       f.applyWorkerReply("SH-950", { stage: "ошибка", reason: "is_error", tokens: { input: 4, output: 2, reasoning: 1 }, sessionReady: false });
       console.log(JSON.stringify(m.readState().tasks["SH-950"]));`,
    );

    expect(code, err).toBe(0);
    const task = JSON.parse(out);
    expect(task.tokens.worker).toMatchObject({ input: 4, output: 2, reasoning: 1 });
    expect(task).toMatchObject({
      stage: "ошибка",
      reason: "is_error",
      pid: 4242,
      pid_started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(readFileSync(join(s.stateDir, "SH-950/log.txt"), "utf8")).toMatch(/этап: в работе → ошибка; is_error/);
  });

  it("[SH-098 AC-13] sessionReady true ставит session_ready, false не сбрасывает true", () => {
    const s = happy();

    const { code, out, err } = nodeEvalAll(
      s.work,
      `${seed()}
       const reply = { stage: "готово", reason: "", tokens: { input: 0, output: 0, reasoning: 0 } };
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
      expect(dshCalls(s)).toHaveLength(0);
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

// SH-098: инструкция воркера и права фабрики не расходятся. Живые пробы claude 2.1.325 (заметки SH-098):
// `$'…'`, `$?`, `$(…)` и `grep` отклоняются, одинарные кавычки с переводом строки, `2>&1` и конвейер в `tail` проходят.
describe("factory: инструкция sh-worker.md и права воркера", () => {
  const workerDoc = readFileSync(join(repoRoot, ".claude/agents/sh-worker.md"), "utf8");

  it("[SH-098 AC-8] sh-worker.md: команды из текста подходят к разрешённым правилам и не подходят к запретам", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();
    const spans = [...workerDoc.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    const commands = spans
      .filter((span) => /^(pnpm (?!factory)|node scripts\/|git (?!push)|backlog task )/.test(span))
      .map((span) => span.replace(/ [<'|].*$/, ""));
    expect(commands.length).toBeGreaterThan(8);
    for (const command of commands) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: нет в разрешённых`,
      ).toBe(true);
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        `${command}: подходит к запрету`,
      ).toBe(false);
    }
  });

  it("[SH-098 AC-8] формы с многострочным текстом из проб подходят к разрешённым правилам", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();
    const forms = [
      "backlog task edit SH-1 --plan '1. шаг\n2. шаг'",
      "backlog task edit SH-1 --notes 'Оценка: 2 ч'",
      "backlog task edit SH-1 --append-notes 'Решение: x'",
      "backlog task edit SH-1 --check-ac 1 --check-ac 2",
      "backlog task edit SH-1 --check-dod 1",
      "backlog task edit SH-1 -s 'In Progress' -a @claude",
      "backlog task edit SH-1 --final-summary 'a\nb'",
      "git commit -m 'feat(x): SH-1 a\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'",
      "git commit -m 'feat(x): SH-1 a' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'",
    ];
    for (const form of forms) {
      expect(
        WORKER_ALLOWED.some((rule) => matchesRule(rule, form)),
        `${form}: нет в разрешённых`,
      ).toBe(true);
      expect(WORKER_DISALLOWED.some((rule) => matchesRule(rule, form))).toBe(false);
    }
  });

  it("[SH-098 AC-7] права воркера не ослаблены: grep и rg запрещены, cat не разрешён, .env закрыт", async () => {
    const { matchesRule, WORKER_ALLOWED, WORKER_DISALLOWED } = await factoryTools();
    for (const command of [
      "grep -n x f",
      "rg x",
      "egrep x f",
      "git push origin x",
      "gh pr list",
      "curl x",
      "pnpm dlx x",
    ])
      expect(
        WORKER_DISALLOWED.some((rule) => matchesRule(rule, command)),
        command,
      ).toBe(true);
    expect(WORKER_ALLOWED.some((rule) => matchesRule(rule, "cat f"))).toBe(false);
    expect(WORKER_ALLOWED.some((rule) => matchesRule(rule, "echo x"))).toBe(false);
    expect(WORKER_DISALLOWED.some((rule) => matchesRule(rule, "cat .env"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SH-094: остановки, ответ владельца и сводка. AC-12 ручной, AC-14 проверяется в ревью.

const OSA_HEAD = [
  "-e",
  "on run argv",
  "-e",
  'display notification (item 1 of argv) with title "Фабрика"',
  "-e",
  "end run",
];
const DEAD_PID = 4_000_000;

// Вызовы подставного osascript с начала последнего runFactory: список аргументов каждого вызова.
const osaCalls = (s: Scenario): string[][] =>
  readFileSync(`${s.log}.osa`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// Папка с подставными pnpm, gh и dsh и с обычными git, ps, sh, env и node, но без osascript.
function binWithoutOsascript(): string {
  const dir = join(workDir, "bin-no-osa");
  if (existsSync(dir)) return dir;
  mkdirSync(dir);
  for (const name of ["pnpm", "gh", "dsh"]) symlinkSync(join(fakeBin, name), join(dir, name));
  for (const name of ["git", "ps", "sh", "env", "sleep"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(dir, name));
  }
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}

// Подготовленная задача SH-901 на нужном этапе с записанной сессией. extra — дополнительные поля записи.
function onStage(s: Scenario, stage: string, extra = "") {
  return prepared(
    s,
    "SH-901",
    TITLE_FABRIKA,
    BRANCH_901,
    `, stage: ${JSON.stringify(stage)}, session_id: "sess-1", session_ready: true${extra}`,
  );
}

// Запись без worktree: для сводки. fields — объект полей.
function putRecord(s: Scenario, id: string, fields: Record<string, unknown>) {
  const result = nodeEval(
    s.work,
    `m.createTask(${JSON.stringify(id)}, { title: "Запись", branch: "sh-x", worktree: "/x", ...${JSON.stringify(fields)} });`,
  );
  if (result.code !== 0) throw new Error(result.err);
}

// JSON-ответ воркера в папке задачи. Номер файла — number.
function putReply(s: Scenario, id: string, number: number, result: string) {
  mkdirSync(join(s.stateDir, id), { recursive: true });
  writeFileSync(
    join(s.stateDir, id, `${String(number).padStart(3, "0")}-worker.json`),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result }),
  );
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const STOP_TEXT = [
  "СТОП SH-901: нужно решение",
  "Вопрос владельцу: Что выбрать и почему?",
  "- А (рекомендую): первый вариант",
  "- Б: второй вариант",
  "Сделано: ничего не менял",
  "Продолжить: вызвать sh-worker.",
].join("\n");

const REMARKS_TEXT = [
  "ЗАМЕЧАНИЯ SH-901",
  "1. Дублирование в a.ts — предлагаю: поправить здесь",
  "2. Хрупкий тест в b.ts — предлагаю: оставить",
  "Вопрос владельцу: какие поправить сейчас? Остальные пойдут в отчёт.",
].join("\n");

const lineOf = (out: string, start: string) => out.split("\n").find((line) => line.startsWith(start));

describe("factory: уведомления", () => {
  it("[SH-094 AC-1] переход на «стоп»: osascript с заголовком «Фабрика» и текстом отдельным аргументом", () => {
    const s = happy();
    prepared(s);

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"]);

    expect(code).toBe(0);
    expect(osaCalls(s)).toEqual([[...OSA_HEAD, "SH-901 · стоп · СТОП SH-901: заглушка"]]);
  }, 20_000);

  it("[SH-094 AC-1] переход на «ошибка»: уведомление с причиной; переход на «в работе» уведомления не даёт", () => {
    const s = happy();
    prepared(s);

    runFactory(s, s.work, ["run", "SH-901", "--foreground"], { env: { FAKE_DSH_RAW: "не json" } });

    const calls = osaCalls(s);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, OSA_HEAD.length)).toEqual(OSA_HEAD);
    expect(calls[0]?.[OSA_HEAD.length]).toBe("SH-901 · ошибка · невалидный JSON");
  }, 20_000);

  it("[SH-094 AC-1] текст длиннее 100 символов отрезается до 100 без многоточия", () => {
    const s = happy();
    prepared(s);
    const result = `СТОП SH-901: ${"я".repeat(200)}`;

    runFactory(s, s.work, ["run", "SH-901", "--foreground"], { env: { FAKE_DSH_RESULT: result } });

    const text = osaCalls(s)[0]?.[OSA_HEAD.length] ?? "";
    expect(Array.from(text)).toHaveLength(100);
    expect(text).toBe(`SH-901 · стоп · ${result}`.slice(0, 100));
    expect(text.endsWith("…")).toBe(false);
  }, 20_000);

  it("[SH-094 AC-2] кавычки, обратная косая черта и апостроф в первой строке доходят до osascript без изменений", () => {
    const s = happy();
    prepared(s);
    const first = `СТОП SH-901: он сказал "да" \\ и 'нет'`;

    const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], {
      env: { FAKE_DSH_RESULT: `${first}\nвторая строка` },
    });

    expect(code).toBe(0);
    expect(osaCalls(s)).toEqual([[...OSA_HEAD, `SH-901 · стоп · ${first}`]]);
    expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
  }, 20_000);

  it.each([
    ["нет osascript в PATH", () => ({ PATH: binWithoutOsascript() })],
    ["osascript завершился с ошибкой", () => ({ FAKE_OSASCRIPT_FAIL: "1" })],
  ])(
    "[SH-094 AC-3] %s: текст в журнале задачи, этап сохранён, код 0",
    (_name, makeEnv) => {
      const s = happy();
      prepared(s);

      const { code } = runFactory(s, s.work, ["run", "SH-901", "--foreground"], { env: makeEnv() });

      expect(code).toBe(0);
      expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
      expect(logOf(s, "SH-901")).toContain("SH-901 · стоп · СТОП SH-901: заглушка");
    },
    20_000,
  );
});

describe("factory: answer", () => {
  const ANSWER = `Да, "кавычки", $HOME и $(date) и \`x\`\nвторая 'строка' \\ конец`;

  it("[SH-094 AC-4] answer на «стоп»: dsh получает session_id, промпт с текстом без изменений, cwd — worktree", async () => {
    const s = happy();
    const { worktree } = onStage(s, "стоп");

    const { code } = runFactory(s, s.work, ["answer", "SH-901", ANSWER]);

    expect(code).toBe(0);
    const calls = dshCalls(s);
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toContain("headless");
    expect(dshFlag(calls[0]!, "--session-id")).toBe("sess-1");
    expect(dshFlag(calls[0]!, "--permission-mode")).toBe("workspace-write");
    expect(args.some((arg) => arg.includes(`Продолжение SH-901. Ответ владельца: ${ANSWER}`))).toBe(true);
    expect(args.some((arg) => arg.includes("sh-worker"))).toBe(true);
    expect(calls[0]?.cwd).toBe(worktree);
  }, 20_000);

  it("[SH-094 AC-5] answer без --foreground: «в работе» с новым pid и временем старта, текст ответа в журнале", async () => {
    const s = happy();
    onStage(s, "стоп");

    const { code } = runFactory(s, s.work, ["answer", "SH-901", ANSWER], { env: SLOW, settle: false });

    try {
      expect(code).toBe(0);
      const task = readTasks(s)["SH-901"];
      expect(task?.stage).toBe("в работе");
      expect(task?.pid).toEqual(expect.any(Number));
      const { processStartedAt } = await factoryModule();
      expect(task?.pid_started_at).toBe(processStartedAt(task?.pid as number));
      expect(logOf(s, "SH-901")).toContain(ANSWER);
    } finally {
      expect(settle(s)).toBe(true);
    }
    expect(readTasks(s)["SH-901"]).toMatchObject({ stage: "стоп", pid: null });
  }, 20_000);

  it("[SH-094 AC-5] answer --foreground: после ответа dsh этап по SH-098, токены воркера накоплены", () => {
    const s = happy();
    onStage(s, "стоп");

    const { code } = runFactory(s, s.work, ["answer", "SH-901", "ответ", "--foreground"], {
      env: { FAKE_DSH_INPUT: "4", FAKE_DSH_OUTPUT: "2", FAKE_DSH_RESULT: "ГОТОВО SH-901" },
    });

    expect(code).toBe(0);
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ stage: "готово", pid: null, pid_started_at: "" });
    expect((task?.tokens as { worker?: unknown } | undefined)?.worker).toMatchObject({ input: 4, output: 2 });
  }, 20_000);

  it.each(["подготовлена", "готово", "ошибка"])(
    "[SH-094 AC-6] answer на этапе «%s»: причина, код 1, dsh не вызван",
    (stage) => {
      const s = happy();
      onStage(s, stage);
      const before = snapshot(s);

      const { code, out } = runFactory(s, s.work, ["answer", "SH-901", "ответ"]);

      expect(code).toBe(1);
      expect(out).toContain(`этапе «${stage}»`);
      expect(dshCalls(s)).toHaveLength(0);
      expect(snapshot(s)).toEqual(before);
    },
  );

  it("[SH-094 AC-6] answer без записи в state.json: причина, код 1, dsh не вызван", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, ["answer", "SH-901", "ответ"]);

    expect(code).toBe(1);
    expect(out).toContain("нет записи");
    expect(dshCalls(s)).toHaveLength(0);
  });

  it("[SH-094 AC-6] answer при двух живых процессах: ID живых задач, код 1, dsh не вызван, этап «стоп»", async () => {
    const s = happy();
    onStage(s, "стоп");
    const a = await liveProcess();
    const b = await liveProcess();
    putRecord(s, "SH-902", { stage: "в работе", pid: a.pid, pid_started_at: a.startedAt });
    putRecord(s, "SH-903", { stage: "в работе", pid: b.pid, pid_started_at: b.startedAt });

    const { code, out } = runFactory(s, s.work, ["answer", "SH-901", "ответ"], { settle: false });

    expect(code).toBe(1);
    expect(out).toContain("SH-902");
    expect(out).toContain("SH-903");
    expect(dshCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("стоп");
  }, 20_000);

  it("[SH-094 AC-13] answer на «стоп» с блоком ЗАМЕЧАНИЯ передаёт ответ так же, как на СТОП", () => {
    const s = happy();
    onStage(s, "стоп", ', reason: "ЗАМЕЧАНИЯ SH-901"');
    putReply(s, "SH-901", 1, REMARKS_TEXT);

    const { code } = runFactory(s, s.work, ["answer", "SH-901", "поправь 1"]);

    expect(code).toBe(0);
    const args = dshCalls(s)[0]!.args;
    expect(args.some((arg) => arg.includes("Продолжение SH-901. Ответ владельца: поправь 1"))).toBe(true);
    expect(dshFlag(dshCalls(s)[0]!, "--session-id")).toBe("sess-1");
  }, 20_000);
});

describe("factory: continue", () => {
  it("[SH-094 AC-7] continue на «ошибка» с session_ready true: session_id прежний и текст «Продолжение SH-901.»", async () => {
    const s = happy();
    const { worktree } = onStage(s, "ошибка");

    const { code } = runFactory(s, s.work, ["continue", "SH-901"]);

    expect(code).toBe(0);
    const calls = dshCalls(s);
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toContain("headless");
    expect(dshFlag(calls[0]!, "--session-id")).toBe("sess-1");
    expect(args.some((arg) => arg.includes("Продолжение SH-901."))).toBe(true);
    expect(args.some((arg) => arg.includes("sh-worker"))).toBe(true);
    expect(calls[0]?.cwd).toBe(worktree);
  }, 20_000);

  it("[SH-094 AC-7] continue на «ошибка» с session_ready false: новый старт в том же worktree без check-spec", async () => {
    const s = happy();
    const { worktree } = prepared(
      s,
      "SH-901",
      TITLE_FABRIKA,
      BRANCH_901,
      ', stage: "ошибка", session_id: "old-sess", session_ready: false',
    );

    const { code, calls: shell } = runFactory(s, s.work, ["continue", "SH-901"]);

    expect(code).toBe(0);
    const calls = dshCalls(s);
    expect(calls).toHaveLength(1);
    const sessionId = readTasks(s)["SH-901"]?.session_id;
    expect(sessionId).toMatch(UUID);
    expect(sessionId).not.toBe("old-sess");
    const args = calls[0]!.args;
    expect(dshFlag(calls[0]!, "--session-id")).toBe(sessionId);
    expect(args.some((arg) => arg.includes(`Новый старт SH-901. Ветка: ${BRANCH_901}.`))).toBe(true);
    expect(args.some((arg) => arg.includes("sh-worker"))).toBe(true);
    expect(calls[0]?.cwd).toBe(worktree);
    expect(shell).not.toContain("pnpm");
    expect(logOf(s, "SH-901")).not.toContain("check-spec");
  }, 20_000);

  it.each(["стоп", "подготовлена", "готово"])("[SH-094 AC-7] continue на этапе «%s»: причина, код 1", (stage) => {
    const s = happy();
    onStage(s, stage);
    const before = snapshot(s);

    const { code, out } = runFactory(s, s.work, ["continue", "SH-901"]);

    expect(code).toBe(1);
    expect(out).toContain(`этапе «${stage}»`);
    expect(dshCalls(s)).toHaveLength(0);
    expect(snapshot(s)).toEqual(before);
  });

  it("[SH-094 AC-7] continue на «в работе» с живым процессом: причина, код 1; без записи: код 1", async () => {
    const s = happy();
    const live = await liveProcess();
    onStage(s, "в работе", `, pid: ${live.pid}, pid_started_at: ${JSON.stringify(live.startedAt)}`);

    const running = runFactory(s, s.work, ["continue", "SH-901"], { settle: false });

    expect(running.code).toBe(1);
    expect(running.out).toContain("этапе «в работе»");
    expect(dshCalls(s)).toHaveLength(0);

    const empty = happy();
    const missing = runFactory(empty, empty.work, ["continue", "SH-901"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("нет записи");
    expect(dshCalls(empty)).toHaveLength(0);
  }, 20_000);

  it("[SH-094 AC-7] continue при двух живых процессах: код 1, dsh не вызван", async () => {
    const s = happy();
    onStage(s, "ошибка");
    const a = await liveProcess();
    const b = await liveProcess();
    putRecord(s, "SH-902", { stage: "в работе", pid: a.pid, pid_started_at: a.startedAt });
    putRecord(s, "SH-903", { stage: "в работе", pid: b.pid, pid_started_at: b.startedAt });

    const { code, out } = runFactory(s, s.work, ["continue", "SH-901"], { settle: false });

    expect(code).toBe(1);
    expect(out).toContain("SH-902");
    expect(dshCalls(s)).toHaveLength(0);
    expect(readTasks(s)["SH-901"]?.stage).toBe("ошибка");
  }, 20_000);
});

describe("factory: drop", () => {
  const sha = (s: Scenario) => git(s.work, "rev-parse", BRANCH_901);

  it("[SH-094 AC-8] drop, ответ y: запись снята, чистый worktree и локальная ветка удалены, SHA напечатан, журнал остался", () => {
    const s = happy();
    const { worktree } = onStage(s, "ошибка");
    const head = sha(s);

    const { code, out } = runFactory(s, s.work, ["drop", "SH-901"], { input: "y\n" });

    expect(code).toBe(0);
    expect(readTasks(s)["SH-901"]).toBeUndefined();
    expect(existsSync(worktree)).toBe(false);
    expect(branchesOf(s.work)).not.toContain(BRANCH_901);
    expect(out).toContain(head);
    expect(existsSync(join(s.stateDir, "SH-901/log.txt"))).toBe(true);
  }, 20_000);

  it("[SH-094 AC-8] drop, ответ n: ничего не меняется", () => {
    const s = happy();
    onStage(s, "ошибка");
    const before = snapshot(s);

    const { code } = runFactory(s, s.work, ["drop", "SH-901"], { input: "n\n" });

    expect(code).toBe(0);
    expect(snapshot(s)).toEqual(before);
  }, 20_000);

  it("[SH-094 AC-8] drop, грязный worktree: запись снята, worktree и ветка остаются и названы", () => {
    const s = happy();
    const { worktree } = onStage(s, "ошибка");
    writeFileSync(join(worktree, "new.txt"), "не закоммичено\n");

    const { code, out } = runFactory(s, s.work, ["drop", "SH-901"], { input: "y\n" });

    expect(code).toBe(0);
    expect(readTasks(s)["SH-901"]).toBeUndefined();
    expect(existsSync(worktree)).toBe(true);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
    expect(out).toContain(worktree);
    expect(out).toContain(BRANCH_901);
  }, 20_000);

  it("[SH-094 AC-8] drop, ветка есть на origin: worktree удалён, ветка остаётся и названа", () => {
    const s = happy();
    const { worktree } = onStage(s, "ошибка");
    git(s.work, "push", "-q", "origin", BRANCH_901);

    const { code, out } = runFactory(s, s.work, ["drop", "SH-901"], { input: "y\n" });

    expect(code).toBe(0);
    expect(readTasks(s)["SH-901"]).toBeUndefined();
    expect(existsSync(worktree)).toBe(false);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
    expect(out).toContain(BRANCH_901);
  }, 20_000);

  it("[SH-094 AC-8] drop при живом процессе задачи: код 1 без вопроса, ничего не меняется", async () => {
    const s = happy();
    const live = await liveProcess();
    onStage(s, "в работе", `, pid: ${live.pid}, pid_started_at: ${JSON.stringify(live.startedAt)}`);
    const before = snapshot(s);

    const { code, out } = runFactory(s, s.work, ["drop", "SH-901"], { input: "y\n", settle: false });

    expect(code).toBe(1);
    expect(out).not.toContain("[y/n]");
    expect(snapshot(s)).toEqual(before);
  }, 20_000);

  it("[SH-094 AC-8] drop без записи: причина, код 1", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, ["drop", "SH-901"], { input: "y\n" });

    expect(code).toBe(1);
    expect(out).toContain("нет записи");
  });
});

describe("factory: сводка", () => {
  const seedSummary = () => {
    const s = happy();
    putRecord(s, "SH-901", { stage: "стоп", stage_changed_at: minutesAgo(59), cost_usd: 0.4 });
    putRecord(s, "SH-902", { stage: "подготовлена", stage_changed_at: minutesAgo(200) });
    putRecord(s, "SH-903", {
      stage: "ошибка",
      reason: "таймаут 180 мин, dsh остановлен",
      stage_changed_at: minutesAgo(119),
      cost_usd: 1.5,
    });
    putRecord(s, "SH-904", { stage: "стоп", stage_changed_at: minutesAgo(130) });
    putReply(s, "SH-901", 1, "СТОП SH-901: старый\nВопрос владельцу: Старый вопрос?\n- А: старый");
    putReply(s, "SH-901", 2, STOP_TEXT);
    return s;
  };

  it("[SH-094 AC-9] строка задачи: ID, этап, время (59 мин, 1 ч при 119 мин), стоимость с двумя знаками", () => {
    const s = seedSummary();

    const { code, out } = runFactory(s, s.work, []);

    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines).toContain("SH-901  стоп  59 мин  $0.40");
    expect(lines).toContain("SH-903  ошибка  1 ч  $1.50");
    expect(lines).toContain("SH-904  стоп  2 ч  $0.00");
    expect(lines).toContain("SH-902  подготовлена  3 ч  $0.00");
  });

  it("[SH-094 AC-9] сначала задачи, которые ждут владельца, внутри групп от старых к новым; в конце «Ждут тебя: N»", () => {
    const s = seedSummary();

    const { out } = runFactory(s, s.work, []);

    const order = ["SH-904  ", "SH-903  ", "SH-901  ", "SH-902  "].map((start) =>
      out.split("\n").findIndex((line) => line.startsWith(start)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const lines = out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("Ждут тебя: 3");
  });

  it("[SH-094 AC-9] «стоп»: вопрос и варианты из последнего по номеру ответа; для «ошибка» — reason и путь журнала", () => {
    const s = seedSummary();

    const { out } = runFactory(s, s.work, []);

    const lines = out.split("\n").map((line) => line.trim());
    expect(lines).toContain("Вопрос владельцу: Что выбрать и почему?");
    expect(lines).toContain("- А (рекомендую): первый вариант");
    expect(lines).toContain("- Б: второй вариант");
    expect(out).not.toContain("Старый вопрос");
    expect(out).not.toContain("Сделано");
    expect(out).toContain("таймаут 180 мин, dsh остановлен");
    expect(out).toContain(join(s.stateDir, "SH-903/log.txt"));
  });

  it("[SH-094 AC-9] отказы: не больше трёх, каждый до 40 символов, при большем числе « …» в конце", () => {
    const s = happy();
    const command = "curl https://example.com/очень/длинный/путь/который/не/влезает";
    putRecord(s, "SH-901", {
      stage: "ошибка",
      reason: "отказы",
      denials: [
        { tool_name: "Bash", tool_input: { command } },
        { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } },
        { tool_name: "Grep", tool_input: { path: "/x/y" } },
        { tool_name: "Write", tool_input: { file_path: "/z" } },
      ],
    });

    const { out } = runFactory(s, s.work, []);

    expect(lineOf(out.replace(/^ +/gm, ""), "Отказы:")).toBe(
      `Отказы: ${command.slice(0, 40)}; Read /etc/passwd; Grep /x/y …`,
    );
  });

  it("[SH-094 AC-9] отказы: три отказа печатаются без « …»", () => {
    const s = happy();
    putRecord(s, "SH-901", {
      stage: "ошибка",
      denials: [
        { tool_name: "Bash", tool_input: { command: "curl x" } },
        { tool_name: "Read", tool_input: { file_path: "/a" } },
        { tool_name: "Write", tool_input: { file_path: "/b" } },
      ],
    });

    const { out } = runFactory(s, s.work, []);

    expect(lineOf(out.replace(/^ +/gm, ""), "Отказы:")).toBe("Отказы: curl x; Read /a; Write /b");
  });

  it("[SH-094 AC-9] другой ждущий этап: строка с reason", () => {
    const s = happy();
    putRecord(s, "SH-901", { stage: "нужен владелец", reason: "проверки не прошли дважды" });

    const { out } = runFactory(s, s.work, []);

    expect(out).toContain("проверки не прошли дважды");
    expect(out).toContain("Ждут тебя: 1");
  });

  it("[SH-094 AC-10] 12 задач на «стоп»: не больше 30 строк, задачи целиком, «…ещё K задач», N считает все", () => {
    const s = happy();
    for (let i = 1; i <= 12; i += 1) {
      const id = `SH-9${String(i).padStart(2, "0")}`;
      putRecord(s, id, { stage: "стоп", stage_changed_at: minutesAgo(200 - i) });
      putReply(s, id, 1, STOP_TEXT.replaceAll("SH-901", id));
    }

    const { out } = runFactory(s, s.work, []);

    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(30);
    expect(lines).toContain("…ещё 5 задач");
    expect(lines[lines.length - 1]).toBe("Ждут тебя: 12");
    for (let i = 1; i <= 7; i += 1) {
      const id = `SH-9${String(i).padStart(2, "0")}`;
      const at = lines.findIndex((line) => line.startsWith(`${id}  стоп`));
      expect(at, id).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at + 1, at + 4).map((line) => line.trim())).toEqual([
        "Вопрос владельцу: Что выбрать и почему?",
        "- А (рекомендую): первый вариант",
        "- Б: второй вариант",
      ]);
    }
    expect(out).not.toContain("SH-908  ");
  });

  it("[SH-094 AC-10] пустое состояние: одна строка «Фабрика пуста»", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, []);

    expect(code).toBe(0);
    expect(out.trimEnd().split("\n")).toEqual(["Фабрика пуста"]);
  });

  // Не по критерию: ревью SH-094. Слово «undefined» не должно считаться пустым вызовом.
  it("команда «undefined» даёт код 2 и использование, как любая неизвестная", () => {
    const s = happy();

    const { code, out } = runFactory(s, s.work, ["undefined"]);

    expect(code).toBe(2);
    expect(out).toContain("Использование:");
  });

  it("[SH-094 AC-13] «стоп» с ответом ЗАМЕЧАНИЯ: пронумерованные замечания и «Вопрос владельцу:», без вариантов", () => {
    const s = happy();
    putRecord(s, "SH-901", { stage: "стоп", reason: "ЗАМЕЧАНИЯ SH-901" });
    putReply(s, "SH-901", 1, REMARKS_TEXT);

    const { out } = runFactory(s, s.work, []);

    const lines = out.split("\n").map((line) => line.trim());
    expect(lines).toContain("1. Дублирование в a.ts — предлагаю: поправить здесь");
    expect(lines).toContain("2. Хрупкий тест в b.ts — предлагаю: оставить");
    expect(lines).toContain("Вопрос владельцу: какие поправить сейчас? Остальные пойдут в отчёт.");
  });
});

describe("factory: процесс завершился без ответа", () => {
  const DEAD_REASON = "процесс завершился без ответа";

  const seedDead = (s: Scenario, pid: number | null) =>
    onStage(s, "в работе", `, pid: ${pid}, pid_started_at: ${pid === null ? '""' : '"2001-01-01T00:00:00.000Z"'}`);

  const expectMarked = (s: Scenario) => {
    expect(logOf(s, "SH-901")).toContain(`этап: в работе → ошибка; ${DEAD_REASON}`);
    expect(osaCalls(s).map((call) => call[OSA_HEAD.length])).toContain(`SH-901 · ошибка · ${DEAD_REASON}`);
  };

  it.each([null, DEAD_PID])(
    "[SH-094 AC-11] сводка: «в работе» с pid %s не жив — «ошибка», reason, уведомление",
    (pid) => {
      const s = happy();
      seedDead(s, pid);

      const { code, out } = runFactory(s, s.work, []);

      expect(code).toBe(0);
      expect(readTasks(s)["SH-901"]).toMatchObject({ stage: "ошибка", reason: DEAD_REASON });
      expect(out).toContain("SH-901  ошибка");
      expect(out).toContain(DEAD_REASON);
      expectMarked(s);
    },
  );

  it("[SH-094 AC-11] run SH-NNN: «в работе» без живого процесса — «ошибка», уведомление, воркер не запущен", () => {
    const s = happy();
    seedDead(s, DEAD_PID);

    const { code } = runFactory(s, s.work, ["run", "SH-901"]);

    expect(code).toBe(1);
    expect(readTasks(s)["SH-901"]).toMatchObject({ stage: "ошибка", reason: DEAD_REASON });
    expect(dshCalls(s)).toHaveLength(0);
    expectMarked(s);
  });

  it("[SH-094 AC-11] answer: «в работе» без живого процесса — «ошибка», уведомление, код 1", () => {
    const s = happy();
    seedDead(s, DEAD_PID);

    const { code, out } = runFactory(s, s.work, ["answer", "SH-901", "ответ"]);

    expect(code).toBe(1);
    expect(out).toContain("этапе «ошибка»");
    expect(dshCalls(s)).toHaveLength(0);
    expectMarked(s);
  });

  it("[SH-094 AC-11] continue: «в работе» без живого процесса — «ошибка», уведомление, затем перезапуск воркера", () => {
    const s = happy();
    seedDead(s, DEAD_PID);

    const { code } = runFactory(s, s.work, ["continue", "SH-901"]);

    expect(code).toBe(0);
    expect(dshCalls(s)).toHaveLength(1);
    expectMarked(s);
  }, 20_000);
});

describe("factory: list", () => {
  const listed = (s: Scenario) => runFactory(s, s.work, ["list"]);
  const rowsOf = (out: string) => out.split("\n").filter((line) => /^SH-\d+\t/.test(line));

  it("[SH-104 AC-1] кандидат: строка SH-NNN, приоритет, название через табуляцию", () => {
    const s = makeRepo([{ id: "SH-901", title: "Первая", priority: "high" }]);

    const { code, out } = listed(s);

    expect(code).toBe(0);
    expect(out.split("\n")).toContain("SH-901\thigh\tПервая");
  });

  it("[SH-104 AC-1] без приоритета вместо него «не указан»", () => {
    const s = makeRepo([{ id: "SH-901", title: "Первая" }]);
    const file = join(s.seed, taskPath("SH-901"));
    writeFileSync(file, readFileSync(file, "utf8").replace(/^priority: .*\n/m, ""));
    git(s.seed, "add", ".");
    git(s.seed, "commit", "-q", "-m", "без приоритета");
    git(s.seed, "push", "-q", "origin", "main");

    const { out } = listed(s);

    expect(out.split("\n")).toContain("SH-901\tне указан\tПервая");
  });

  it("[SH-104 AC-2] три кандидата: строки по возрастанию номера", () => {
    const s = makeRepo([
      { id: "SH-903", title: "Третья" },
      { id: "SH-901", title: "Первая" },
      { id: "SH-902", title: "Вторая" },
    ]);

    const { out } = listed(s);

    expect(rowsOf(out).map((line) => line.split("\t")[0])).toEqual(["SH-901", "SH-902", "SH-903"]);
  });

  it("[SH-104 AC-3] задача с зависимостью не в Done стоит в блоке «Ждут зависимость:» такой же строкой", () => {
    const s = makeRepo([
      { id: "SH-901", title: "Первая" },
      { id: "SH-903", title: "Ждущая", deps: ["SH-911"], priority: "low" },
      { id: "SH-911", title: "Идущая", status: "In Progress" },
    ]);

    const { out } = listed(s);

    const lines = out.split("\n");
    const at = lines.indexOf("Ждут зависимость:");
    expect(at).toBeGreaterThan(lines.indexOf("SH-901\tmedium\tПервая"));
    expect(lines.slice(at + 1)).toContain("SH-903\tlow\tЖдущая");
    expect(lines.slice(0, at)).not.toContain("SH-903\tlow\tЖдущая");
  });

  it("[SH-104 AC-4] ничего не создано: ни ветки, ни worktree, ни записи, ни процесса; код 0", () => {
    const s = makeRepo([{ id: "SH-901", title: "Первая" }]);
    const before = snapshot(s);

    const { code } = listed(s);

    expect(code).toBe(0);
    expect(snapshot(s)).toEqual(before);
    expect(pidRecords(s)).toEqual([]);
    expect(dshCalls(s)).toHaveLength(0);
  });

  it("[SH-104 AC-9] run после выноса отбора: те же кандидаты, что у list, а run по номеру запускает воркера как раньше", () => {
    const s = makeRepo([
      { id: "SH-901", title: "Первая", priority: "high" },
      { id: "SH-902", title: "Вторая" },
      { id: "SH-903", title: "Ждущая", deps: ["SH-910"] },
    ]);

    const picked = runFactory(s, s.work, ["run"], { input: "\n" });
    const listedOut = listed(s);

    expect(picked.code).toBe(0);
    for (const id of ["SH-901", "SH-902"]) {
      expect(picked.out).toMatch(new RegExp(`^\\d+\\. ${id} `, "m"));
      expect(rowsOf(listedOut.out).some((row) => row.startsWith(`${id}\t`))).toBe(true);
    }
    expect(picked.out).not.toMatch(/^\d+\. SH-903 /m);
    expect(dshCalls(s)).toHaveLength(0);

    const started = runFactory(s, s.work, ["run", "SH-901"]);

    expect(started.code).toBe(0);
    expect(started.out).toContain("SH-901: воркер запущен");
    expect(dshCalls(s)).toHaveLength(1);
  }, 30_000);

  it("[SH-104 AC-5] кандидатов нет: первая строка «Задач в Ready нет», блок ожидающих после неё, код 0", () => {
    const s = makeRepo([
      { id: "SH-903", title: "Ждущая", deps: ["SH-911"] },
      { id: "SH-911", title: "Идущая", status: "In Progress" },
    ]);

    const { code, out } = listed(s);

    expect(code).toBe(0);
    const lines = out.split("\n").filter(Boolean);
    expect(lines[0]).toBe("Задач в Ready нет");
    expect(lines[1]).toBe("Ждут зависимость:");
    expect(lines[2]).toBe("SH-903\tmedium\tЖдущая");
  });

  it("[SH-104 AC-5] кандидатов и ожидающих нет: одна строка «Задач в Ready нет», код 0", () => {
    const s = makeRepo([{ id: "SH-909", status: "In Progress" }]);

    const { code, out } = listed(s);

    expect(code).toBe(0);
    expect(out.trim()).toBe("Задач в Ready нет");
  });

  it("[SH-104 AC-6] задача, добавленная в origin/main после клонирования, видна", () => {
    const s = makeRepo([{ id: "SH-901", title: "Первая" }]);
    writeFileSync(join(s.seed, taskPath("SH-902")), taskFile({ id: "SH-902", title: "Новая" }));
    git(s.seed, "add", ".");
    git(s.seed, "commit", "-q", "-m", "новая задача");
    git(s.seed, "push", "-q", "origin", "main");

    const { out } = listed(s);

    expect(out.split("\n")).toContain("SH-902\tmedium\tНовая");
  });

  it("[SH-104 AC-7] сбой git fetch origin: тот же вывод и код, что у run", () => {
    const s = makeRepo([{ id: "SH-901", title: "Первая" }]);
    git(s.work, "remote", "set-url", "origin", join(s.base, "нет-такого.git"));

    const run = runFactory(s, s.work, ["run"]);
    const list = listed(s);

    expect(run.code).toBe(1);
    expect(list.code).toBe(run.code);
    expect(list.out).toContain("git fetch origin не удался");
    expect(list.out).toBe(run.out);
  });

  it.each([["x"], ["--foreground"], ["SH-901"]])("[SH-104 AC-8] list %s: в stderr использование, код 2", (arg) => {
    const s = makeRepo([{ id: "SH-901", title: "Первая" }]);

    const result = spawnSync(process.execPath, [script, "list", arg], {
      cwd: s.work,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: s.log },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm factory run [SH-NNN] [--foreground] | list");
    expect(result.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SH-107: фабрика-оркестратор — команды ready/next/merge/status, запуск модели через `dsh headless`,
// поля задачи «Права»/«Затрагивает»/«Модель» и новые поля состояния.

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// Коммитит файлы в worktree задачи одной командой git.
function commitFiles(worktree: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(worktree, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", message);
}

// Красный коммит (только тесты) и коммит реализации (только код): правильный порядок TDD.
const RED_TEST =
  'import { describe, expect, it } from "vitest";\nimport { add } from "../src/add";\n' +
  'describe("add", () => { it("[SH-901 AC-1] складывает", () => { expect(add(1, 2)).toBe(3); }); });\n';
const IMPL = "export const add = (a: number, b: number): number => a + b;\n";

function commitRedGreen(worktree: string) {
  commitFiles(worktree, { "tests/add.test.ts": RED_TEST }, "красный: тесты");
  commitFiles(worktree, { "src/add.ts": IMPL }, "реализация");
}

// Задача в работе: ветка, worktree, запись с worker_signal «закончил», коммиты TDD и пуш ветки.
function taskInWork(s: Scenario, opts: { round?: number; remarks?: number; prUrl?: string; push?: boolean } = {}) {
  const { worktree, branch } = prepared(
    s,
    "SH-901",
    TITLE_FABRIKA,
    BRANCH_901,
    `, worker_signal: "закончил", round: ${opts.round ?? 1}, remarks_count: ${opts.remarks ?? 0}, worker_session_id: "sess-1"${
      opts.prUrl ? `, pr_url: ${JSON.stringify(opts.prUrl)}` : ""
    }`,
  );
  commitRedGreen(worktree);
  if (opts.push !== false) git(worktree, "push", "-q", "origin", branch);
  return { worktree, branch };
}

// Репозиторий для AC-10: задача с «Затрагивает» docs/foo.md, который меняется после перехода задачи в Ready.
function affectedRepo(): Scenario {
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
  mkdirSync(join(seed, "docs"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "readme\n");
  writeFileSync(join(seed, ".gitignore"), ".claude/worktrees/\n");
  writeFileSync(join(seed, "docs/foo.md"), "v1\n");
  writeFileSync(
    join(seed, taskPath("SH-901")),
    taskFile({ id: "SH-901", title: TITLE_FABRIKA, affects: ["docs/foo.md"] }),
  );
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "ready");
  git(seed, "push", "-q", "origin", "main");
  writeFileSync(join(seed, "docs/foo.md"), "v2\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "изменили docs/foo.md");
  git(seed, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, work);
  return { base, origin, work, seed, log: join(base, "fake.log"), stateDir: join(work, ".git/factory") };
}

const reviewerCall = (s: Scenario) =>
  dshCalls(s).find((c) => c.args.includes("deepseek-v4-pro") && c.args.includes("max"));

const settingsOf = (s: Scenario, branch: string) => {
  const path = join(s.work, ".claude/worktrees", branch, ".claude/settings.local.json");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

describe("factory-tools: agentInvocation (SH-107)", () => {
  it("[SH-107 AC-17] возвращает dsh, headless, --json, --session-id и права по readOnly", async () => {
    const { agentInvocation } = await factoryTools();
    const inv = agentInvocation("sh-reviewer", { sessionId: "sess-1", worktree: "/w" });
    expect(inv.command).toBe("dsh");
    expect(inv.args).toContain("headless");
    expect(inv.args).toContain("--json");
    expect(inv.args).toContain("--session-id");
    expect(argAfter(inv.args, "--session-id")).toBe("sess-1");
    expect(inv.args).toContain("--permission-mode");
    expect(argAfter(inv.args, "--permission-mode")).toBe("read-only");
    expect(inv.prompt).toContain("sh-reviewer");
  });

  it("[SH-107 AC-17] sh-reviewer: deepseek-v4-pro, max, read-only", async () => {
    const { agentInvocation } = await factoryTools();
    const inv = agentInvocation("sh-reviewer", {});
    expect(inv.args).toContain("deepseek-v4-pro");
    expect(inv.args).toContain("max");
    expect(argAfter(inv.args, "--permission-mode")).toBe("read-only");
    expect(inv.prompt).toContain("sh-reviewer");
  });

  it("[SH-107 AC-11] worker по полю Модель: pro → deepseek-v4-pro + high, flash → deepseek-flash; readOnly=false → workspace-write", async () => {
    const { agentInvocation } = await factoryTools();
    const pro = agentInvocation("sh-worker", { model: "deepseek-v4-pro", effort: "high" });
    expect(pro.args).toContain("deepseek-v4-pro");
    expect(pro.args).toContain("high");
    expect(argAfter(pro.args, "--permission-mode")).toBe("workspace-write");
    const flash = agentInvocation("sh-worker", { model: "deepseek-flash" });
    expect(flash.args).toContain("deepseek-flash");
    expect(flash.args).not.toContain("high");
    expect(flash.args).not.toContain("max");
  });

  it("[SH-107 AC-39] sh-retro: deepseek-flash и read-only; sh-verifier: deepseek-flash", async () => {
    const { agentInvocation } = await factoryTools();
    const retro = agentInvocation("sh-retro", {});
    expect(retro.args).toContain("deepseek-flash");
    expect(argAfter(retro.args, "--permission-mode")).toBe("read-only");
    expect(retro.prompt).toContain("sh-retro");
    const verifier = agentInvocation("sh-verifier", {});
    expect(verifier.args).toContain("deepseek-flash");
  });
});

describe("factory-state: поля SH-107", () => {
  it("[SH-107 AC-40] newTask включает worker_session_id, round, remarks_count, worker_signal и tokens по агентам", () => {
    const s = happy();
    const { code, out, err } = nodeEval(s.work, `console.log(JSON.stringify(m.newTask("SH-901")));`);
    expect(err).toBe("");
    expect(code).toBe(0);
    const task = JSON.parse(out);
    expect(task).toMatchObject({
      worker_session_id: "",
      round: 0,
      remarks_count: 0,
      worker_signal: "",
    });
    expect(task.tokens).toEqual({
      worker: { input: 0, output: 0, reasoning: 0 },
      verifier: { input: 0, output: 0, reasoning: 0 },
      reviewer: { input: 0, output: 0, reasoning: 0 },
      retro: { input: 0, output: 0, reasoning: 0 },
    });
  });
});

describe("check-spec: поля Права и Модель (SH-107)", () => {
  it("[SH-107 AC-11] известное значение Права (docker) и Модель pro: OK", () => {
    const s = makeRepo([{ id: "SH-901", title: "Задача", rights: ["docker"], model: "pro" }]);
    const { code, out } = runCheckSpec(s.work, "SH-901");
    expect(code).toBe(0);
    expect(out).toContain("SH-901: OK");
  });

  it("[SH-107 AC-11] неизвестное значение Права отклоняется", () => {
    const s = makeRepo([{ id: "SH-901", title: "Задача", rights: ["sudo"] }]);
    const { code, out } = runCheckSpec(s.work, "SH-901");
    expect(code).toBe(1);
    expect(out).toContain("ОШИБКА");
    expect(out).toMatch(/права/i);
  });

  it("[SH-107 AC-11] неизвестное значение Модель отклоняется", () => {
    const s = makeRepo([{ id: "SH-901", title: "Задача", model: "ultra" }]);
    const { code, out } = runCheckSpec(s.work, "SH-901");
    expect(code).toBe(1);
    expect(out).toContain("ОШИБКА");
    expect(out).toMatch(/модел/i);
  });

  it("[SH-107 AC-11] Модель по умолчанию pro: без поля ошибки нет", () => {
    const s = makeRepo([{ id: "SH-901", title: "Задача" }]);
    const { code, out } = runCheckSpec(s.work, "SH-901");
    expect(code).toBe(0);
    expect(out).toContain("SH-901: OK");
  });
});

describe("factory: ready (SH-107)", () => {
  it("[SH-107 AC-9] создаёт ветку, worktree, запись состояния, права и модель в настройках worktree и бриф", () => {
    const s = makeRepo([{ id: "SH-901", title: TITLE_FABRIKA, rights: ["docker"], model: "pro" }]);
    const { code, out } = runFactory(s, s.work, ["ready", "SH-901"]);
    expect(code).toBe(0);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
    const worktree = join(s.work, ".claude/worktrees", BRANCH_901);
    expect(existsSync(join(worktree, "backlog/tasks"))).toBe(true);
    const task = readTasks(s)["SH-901"];
    expect(task).toMatchObject({ branch: BRANCH_901, worktree });
    for (const field of ["worker_session_id", "round", "remarks_count", "worker_signal", "tokens"]) {
      expect(task).toHaveProperty(field);
    }
    const settings = settingsOf(s, BRANCH_901);
    expect(settings).toContain("docker");
    expect(settings).toContain("git push");
    expect(settings).toContain("deepseek-v4-pro");
    expect(out).toContain("SH-901");
    expect(out).toContain(BRANCH_901);
  });

  it("[SH-107 AC-11] Модель pro → deepseek-v4-pro в настройках worktree, flash → deepseek-flash", () => {
    const pro = makeRepo([{ id: "SH-901", title: TITLE_FABRIKA, model: "pro" }]);
    runFactory(pro, pro.work, ["ready", "SH-901"]);
    expect(settingsOf(pro, BRANCH_901)).toContain("deepseek-v4-pro");

    const flash = makeRepo([{ id: "SH-901", title: TITLE_FABRIKA, model: "flash" }]);
    runFactory(flash, flash.work, ["ready", "SH-901"]);
    expect(settingsOf(flash, BRANCH_901)).toContain("deepseek-flash");
    expect(settingsOf(flash, BRANCH_901)).not.toContain("deepseek-v4-pro");
  });
});

describe("factory: ready и актуальность по Затрагивает (SH-107)", () => {
  it("[SH-107 AC-10] изменённый файл из «Затрагивает» печатается, задача не готовится без подтверждения", () => {
    const s = affectedRepo();
    const { out } = runFactory(s, s.work, ["ready", "SH-901"]);
    expect(out).toContain("docs/foo.md");
    expect(branchesOf(s.work).filter((name) => name.startsWith("sh-901-"))).toHaveLength(0);
    expect(existsSync(join(s.work, ".claude/worktrees", BRANCH_901))).toBe(false);
  });

  it("[SH-107 AC-10] подтверждение владельца готовит задачу, несмотря на изменения", () => {
    const s = affectedRepo();
    const { code, out } = runFactory(s, s.work, ["ready", "SH-901"], { input: "y\n" });
    expect(code).toBe(0);
    expect(branchesOf(s.work)).toContain(BRANCH_901);
    expect(out).toContain("docs/foo.md");
  });
});

describe("factory: next — проверки DoD (SH-107)", () => {
  it("[SH-107 AC-13] красные проверки DoD: «доработать» со списком ошибок, ревьюер не запущен", () => {
    const s = happy();
    prepared(s);
    commitRedGreen(join(s.work, ".claude/worktrees", BRANCH_901));
    const { out } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_PNPM_FAIL: "1" } });
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("доработать");
    expect(lines.length).toBeGreaterThan(2);
    expect(reviewerCall(s)).toBeUndefined();
  });

  it("[SH-107 AC-14] нет теста с меткой [SH-NNN AC-n] → «доработать»", () => {
    const s = happy();
    prepared(s);
    commitRedGreen(join(s.work, ".claude/worktrees", BRANCH_901));
    const { out } = runFactory(s, s.work, ["next", "SH-901"], {
      env: { FAKE_PNPM_FAIL_MATCH: "ac:check", FAKE_PNPM_FAIL_OUTPUT: "нет теста с меткой [SH-901 AC-2]" },
    });
    expect(out.trim().split("\n")[0]).toBe("доработать");
    expect(out).toContain("[SH-901 AC-2]");
    expect(reviewerCall(s)).toBeUndefined();
  });

  it("[SH-107 AC-15] в красном коммите есть не-тестовые файлы → «доработать»", () => {
    const s = happy();
    const { worktree } = prepared(s);
    commitFiles(worktree, { "src/index.ts": "x", "tests/a.test.ts": "y" }, "красный");
    const { out } = runFactory(s, s.work, ["next", "SH-901"]);
    expect(out.trim().split("\n")[0]).toBe("доработать");
    expect(reviewerCall(s)).toBeUndefined();
  });

  it("[SH-107 AC-16] изменены проверки тестов после красного коммита → «доработать» и запуск sh-verifier", () => {
    const s = happy();
    const { worktree } = prepared(s);
    commitFiles(worktree, { "tests/a.test.ts": "it('x', () => {})" }, "красный");
    commitFiles(worktree, { "tests/a.test.ts": "it('x', () => { expect(1).toBe(1) })" }, "правка теста");
    const { out } = runFactory(s, s.work, ["next", "SH-901"]);
    expect(out.trim().split("\n")[0]).toBe("доработать");
    const verifier = dshCalls(s).find((c) => c.args.some((a) => a.includes("sh-verifier")));
    expect(verifier).toBeDefined();
    expect(reviewerCall(s)).toBeUndefined();
  });
});

describe("factory: next — ревьюер (SH-107)", () => {
  it("[SH-107 AC-17] ревьюер запускается фабрикой как dsh headless с моделью, уровнем и правами", () => {
    const s = happy();
    const { worktree } = taskInWork(s);
    runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_DSH_RESULT: "чисто" } });
    const reviewer = reviewerCall(s);
    expect(reviewer).toBeDefined();
    expect(reviewer!.args).toContain("headless");
    expect(reviewer!.args).toContain("--json");
    expect(argAfter(reviewer!.args, "--permission-mode")).toBe("read-only");
    expect(reviewer!.args.some((a) => a.includes("sh-reviewer"))).toBe(true);
    expect(reviewer!.cwd).toBe(worktree);
  });

  it("[SH-107 AC-18] вердикт «блокирует» на 1-м круге: «доработать, замечания в файле X» и переход на 2-й круг", () => {
    const s = happy();
    const { worktree } = taskInWork(s, { round: 1 });
    const verdict = "блокирует: 2\n- блокирует: нарушено правило ТД §1\n- замечание: имя переменной";
    const { out } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_DSH_RESULT: verdict } });
    expect(out.trim().split("\n")[0]).toContain("доработать");
    expect(out).toMatch(/замечания в файле/);
    expect(readTasks(s)["SH-901"]?.round).toBe(2);
    expect(readTasks(s)["SH-901"]?.remarks_count).toBe(2);
    expect(existsSync(join(worktree, "docs", "review-SH-901.md"))).toBe(true);
  });

  it("[SH-107 AC-19] вердикт «чисто»: создаётся PR", () => {
    const s = happy();
    taskInWork(s);
    const { out, calls } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_DSH_RESULT: "чисто" } });
    expect(calls).toContain("gh pr create");
    expect(readTasks(s)["SH-901"]?.pr_url).toBeTruthy();
    expect(out).toContain("PR");
  });

  it.each([
    ["невалидный формат ответа", { FAKE_DSH_RAW: "not-json" }],
    ["ненулевой код процесса", { FAKE_DSH_EXIT: "3" }],
    [
      "исчерпанный бюджет",
      { FAKE_DSH_RAW: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "" }) },
    ],
  ])("[SH-107 AC-20] %s → «ошибка», а не «чисто»", (_name, env) => {
    const s = happy();
    taskInWork(s);
    const { out, calls } = runFactory(s, s.work, ["next", "SH-901"], { env });
    expect(out.trim().split("\n")[0]).toBe("ошибка");
    expect(out).not.toContain("чисто");
    expect(calls).not.toContain("gh pr create");
  });
});

describe("factory: next — CI и этапы (SH-107)", () => {
  it("[SH-107 AC-21] красный CI: «доработать» с логом ошибок", () => {
    const s = happy();
    taskInWork(s);
    const { out } = runFactory(s, s.work, ["next", "SH-901"], {
      env: { FAKE_DSH_RESULT: "чисто", FAKE_GH_CHECKS: '{"state":"FAILURE","log":"сбой сборки"}' },
    });
    expect(out.trim().split("\n")[0]).toBe("доработать");
    expect(out).toMatch(/сбой сборки|FAILURE|ошиб/);
  });

  it("[SH-107 AC-22] зелёный CI: состояние «готов к ревью» и «PR готов, замечаний: N»", () => {
    const s = happy();
    taskInWork(s);
    const { out } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_DSH_RESULT: "чисто" } });
    expect(out).toContain("PR готов");
    expect(out).toMatch(/замечаний:\s*\d+/);
    expect(readTasks(s)["SH-901"]?.stage).toContain("готов к ревью");
  });

  it("[SH-107 AC-23] первая строка — действие, вторая — фраза этапа; этап в state.json и показывается status", () => {
    const s = happy();
    prepared(s);
    commitRedGreen(join(s.work, ".claude/worktrees", BRANCH_901));
    const { out } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_PNPM_FAIL: "1" } });
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("доработать");
    expect(lines[1]).toBeTruthy();
    expect(lines[1]).not.toBe(lines[0]);
    expect(readTasks(s)["SH-901"]?.stage).toBe(lines[1]);
    const status = runFactory(s, s.work, ["status"]);
    expect(status.out).toContain(lines[1]);
  });

  it("[SH-107 AC-24] после правок владельца next проходит полный круг: DoD, ревьюер, обновление PR и новый CI", () => {
    const s = happy();
    const { worktree } = taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    commitFiles(
      worktree,
      { "src/add.ts": "export const add = (a: number, b: number): number => a + b + 1;\n" },
      "правки владельца",
    );
    const { out, calls } = runFactory(s, s.work, ["next", "SH-901"], { env: { FAKE_DSH_RESULT: "чисто" } });
    expect(reviewerCall(s)).toBeDefined();
    expect(calls).toMatch(/gh pr (create|view|checks|merge)/);
    expect(out).toContain("PR готов");
  });
});

describe("factory: merge (SH-107)", () => {
  it("[SH-107 AC-25] зелёный CI: коммитит статус Merged и сливает PR squash", () => {
    const s = happy();
    taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    const { code, calls } = runFactory(s, s.work, ["merge", "SH-901"]);
    expect(code).toBe(0);
    expect(calls).toMatch(/gh pr merge/);
    expect(calls).toContain("--squash");
  });

  it("[SH-107 AC-26] после слияния удаляет ветку и worktree и подтягивает main в основной папке", () => {
    const s = happy();
    const { worktree } = taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    const { code } = runFactory(s, s.work, ["merge", "SH-901"]);
    expect(code).toBe(0);
    expect(branchesOf(s.work)).not.toContain(BRANCH_901);
    expect(existsSync(worktree)).toBe(false);
    expect(git(s.work, "rev-parse", "main")).toBe(git(s.work, "rev-parse", "origin/main"));
  });

  it("[SH-107 AC-27] красный или незавершённый CI: отказ без изменений", () => {
    const s = happy();
    taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    const before = snapshot(s);
    const { code, calls } = runFactory(s, s.work, ["merge", "SH-901"], {
      env: { FAKE_GH_CHECKS: '{"state":"FAILURE"}' },
    });
    expect(code).toBe(1);
    expect(calls).not.toContain("gh pr merge");
    expect(snapshot(s)).toEqual(before);
  });

  it("[SH-107 AC-39] запускает sh-retro на deepseek-flash и коммитит запись в docs/process-retro.md", () => {
    const s = happy();
    taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    const entry = "## SH-901\n- Причина: неоднозначный критерий\n- Предложение: уточнить критерий";
    const { out } = runFactory(s, s.work, ["merge", "SH-901"], { env: { FAKE_DSH_RESULT: entry } });
    const retro = dshCalls(s).find(
      (c) => c.args.includes("deepseek-flash") && c.args.some((a) => a.includes("sh-retro")),
    );
    expect(retro).toBeDefined();
    expect(retro!.args).toContain("headless");
    expect(argAfter(retro!.args, "--permission-mode")).toBe("read-only");
    expect(git(s.work, "show", "origin/main:docs/process-retro.md")).toContain("неоднозначный критерий");
    expect(out).toMatch(/gh pr merge/);
  });

  it("[SH-107 AC-40] печатает строку с токенами и стоимостью в юанях; state имеет разбивку по агентам", () => {
    const s = happy();
    taskInWork(s, { prUrl: "https://github.com/x/y/pull/1" });
    const { out } = runFactory(s, s.work, ["merge", "SH-901"], {
      env: {
        FAKE_DSH_RESULT: "## SH-901\n- Причина: x",
        FAKE_DSH_INPUT: "1000",
        FAKE_DSH_OUTPUT: "200",
        FAKE_DSH_REASONING: "300",
      },
    });
    expect(out).toMatch(/токен/i);
    expect(out).toMatch(/юан|¥|CNY/i);
    const stateText = readFileSync(stateFileOf(s), "utf8");
    for (const agent of ["worker", "verifier", "reviewer", "retro"]) expect(stateText).toContain(agent);
  });

  it("[SH-107 AC-40] цены — константы в factory-tools: числа больше нуля для deepseek-v4-pro и deepseek-flash", async () => {
    const tools = await factoryTools();
    expect(typeof tools.MODEL_PRICE_CNY_PER_MTOK).toBe("object");
    const prices = tools.MODEL_PRICE_CNY_PER_MTOK;
    for (const model of ["deepseek-v4-pro", "deepseek-flash"]) {
      expect(prices?.[model]).toBeDefined();
      expect(Number.isFinite(prices?.[model]?.input)).toBe(true);
      expect(prices?.[model]?.input).toBeGreaterThan(0);
      expect(Number.isFinite(prices?.[model]?.output)).toBe(true);
      expect(prices?.[model]?.output).toBeGreaterThan(0);
    }
  });
});

describe("factory: запасной вариант и удаление close-task (SH-107)", () => {
  it("[SH-107 AC-34] package.json не имеет close-task, scripts/close-task.mjs не существует", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts?.["close-task"]).toBeUndefined();
    expect(existsSync(join(repoRoot, "scripts/close-task.mjs"))).toBe(false);
  });

  it("[SH-107 AC-35] запасной run запускает воркера через dsh headless, а не claude", () => {
    const s = happy();
    const { code } = runFactory(s, s.work, ["run", "SH-901"]);
    expect(code).toBe(0);
    expect(dshCalls(s).length).toBeGreaterThan(0);
    expect(dshCalls(s)[0]?.args).toContain("headless");
    expect(claudeCalls(s)).toHaveLength(0);
  });
});
