#!/usr/bin/env node
// `pnpm factory run [SH-NNN]`: фабрика готовит задачу к работе (ADR 0010, docs/process.md §7.1).
// Скрипт без модели: правила выполняет код. Запускается из любой папки клона; основная папка берётся из первой записи
// `git worktree list --porcelain`, все операции идут в ней.
// 1. `git fetch origin`, задачи читаются из origin/main (`git show`), а не из рабочей папки.
// 2. Кандидат: статус Ready, все зависимости в Done, нет ветки sh-NNN-* (локальной и на origin), worktree и записи фабрики.
// 3. Без аргумента скрипт печатает кандидатов и спрашивает номер (одного кандидата — y/n). С аргументом выбор пропущен.
// 4. Для выбранной задачи: ветка `sh-NNN-<slug>` и worktree `<основная папка>/.claude/worktrees/<ветка>` от origin/main,
//    `check-spec.mjs` и `pnpm install --frozen-lockfile` в worktree, запись в состоянии на этапе «подготовлена».
//    При любой ошибке ветка и worktree, созданные этой командой, удаляются, код 1.
// Состояние: scripts/lib/factory-state.mjs. Запуск воркера добавляет SH-098.
// Коды выхода: 0 — задача подготовлена или ничего не запущено по выбору; 1 — задача не запущена; 2 — неверный вызов.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTask } from "./lib/backlog-task.mjs";
import { createTask, logLine, readState, StateBusyError } from "./lib/factory-state.mjs";
import { listWorktrees, tryGit } from "./lib/git.mjs";

const TARGET = "origin/main";
const CHECK_SPEC = fileURLToPath(new URL("./check-spec.mjs", import.meta.url));
const SLUG_MAX = 30;
const SLUG_WORDS = 3;
const INSTALL_TAIL = 20;

const TRANSLIT = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ы: "y",
  э: "e",
  ю: "yu",
  я: "ya",
  ъ: "",
  ь: "",
};

// Slug ветки из названия задачи: транслитерация, первые три слова, длина не больше 30.
export function slugify(title) {
  const words = [];
  let word = "";
  for (const char of String(title).toLowerCase()) {
    if (Object.hasOwn(TRANSLIT, char)) word += TRANSLIT[char];
    else if (/[a-z0-9]/.test(char)) word += char;
    else {
      if (word) words.push(word);
      word = "";
    }
  }
  if (word) words.push(word);
  const picked = words.slice(0, SLUG_WORDS);
  while (picked.length > 1 && picked.join("-").length > SLUG_MAX) picked.pop();
  const slug = picked.join("-").slice(0, SLUG_MAX).replace(/-+$/, "");
  return slug === "" ? "task" : slug;
}

const oneLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")[0]
    .trim();

// Задачи из origin/main: файлы читаются через git, рабочая папка не участвует.
function readOriginTasks() {
  const listed = tryGit(["ls-tree", "-z", "--name-only", TARGET, "backlog/tasks/"]);
  if (!listed.ok) return [];
  return listed.stdout
    .split("\0")
    .filter((path) => path.endsWith(".md"))
    .map((path) => {
      const shown = tryGit(["show", `${TARGET}:${path}`]);
      return shown.ok ? parseTask(shown.stdout) : null;
    })
    .filter((task) => task?.id);
}

// Ветки, worktree и записи фабрики, по которым видно, что задачу уже начали.
function readContext() {
  const refs = tryGit(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  const local = [];
  const origin = [];
  for (const ref of refs.stdout.split("\n")) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/origin/")) origin.push(ref.slice("refs/remotes/".length));
  }
  const worktrees = listWorktrees().filter((tree) => tree.branch);
  return { local, origin, worktrees, records: readState().tasks };
}

const taskBranches = (names, id) =>
  names.filter((name) => name.replace(/^origin\//, "").startsWith(`${id.toLowerCase()}-`));

// Причины, по которым задачу нельзя запустить. Пустой список — кандидат. waiting: Ready, но ждёт зависимость.
function blockers(task, statuses, context) {
  if (task.status !== "Ready")
    return { reasons: [`статус ${task.status || "не указан"}, нужен Ready`], waiting: false };
  const reasons = [];
  const pending = task.dependencies.filter((id) => statuses.get(id) !== "Done");
  const started = [];
  for (const name of taskBranches(context.local, task.id)) started.push(`есть ветка ${name}`);
  for (const name of taskBranches(context.origin, task.id)) started.push(`есть ветка ${name}`);
  for (const tree of context.worktrees)
    if (taskBranches([tree.branch], task.id).length > 0) started.push(`есть worktree ${tree.path}`);
  const record = context.records[task.id];
  if (record && record.stage !== "подготовлена") started.push(`есть запись фабрики на этапе «${record.stage}»`);
  if (pending.length > 0) reasons.push(`зависимость ${pending.join(", ")} не в Done`);
  reasons.push(...started);
  const alreadyStarted = started.length > 0 || Boolean(record);
  return { reasons, waiting: pending.length > 0 && !alreadyStarted };
}

const naming = (task) => `${task.id} ${task.title}`;

function printList(candidates, waiting, statuses) {
  if (candidates.length > 0) {
    process.stdout.write("Готовы к запуску:\n");
    candidates.forEach((task, i) => {
      process.stdout.write(
        `${i + 1}. ${naming(task)} (приоритет: ${task.priority || "не указан"}, критериев: ${task.criteria.length})\n`,
      );
    });
  }
  if (waiting.length > 0) {
    process.stdout.write("Ждут зависимость:\n");
    for (const task of waiting) {
      const pending = task.dependencies.filter((id) => statuses.get(id) !== "Done");
      process.stdout.write(`  ${naming(task)} (ждёт ${pending.join(", ")})\n`);
    }
  }
}

// Читает одну строку со стандартного ввода. Закрытый ввод даёт пустую строку.
function ask(question) {
  return new Promise((done) => {
    process.stdout.write(question);
    const rl = createInterface({ input: process.stdin });
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      done(line.trim());
    });
    rl.once("close", () => {
      if (!answered) done("");
    });
  });
}

// Выбранная задача или null. Любой ответ, кроме номера из списка (или y для одного кандидата), отменяет запуск.
async function choose(candidates) {
  if (candidates.length === 1) {
    const answer = await ask(`Запустить ${candidates[0].id}? [y/n] `);
    return /^(y|yes)$/i.test(answer) ? candidates[0] : null;
  }
  const answer = await ask("Номер задачи (пустой ввод — отмена): ");
  if (!/^\d+$/.test(answer)) return null;
  return candidates[Number(answer) - 1] ?? null;
}

// Запуск команды с записью в журнал задачи.
function runLogged(id, command, args, options = {}) {
  logLine(id, `${command} ${args.join(" ")}${options.cwd ? ` (cwd ${options.cwd})` : ""}`);
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

// `pnpm install --frozen-lockfile` с выводом stdout и stderr в один файл: порядок строк сохраняется.
function installDependencies(id, worktree) {
  const dir = mkdtempSync(join(tmpdir(), "factory-install-"));
  const file = join(dir, "output.txt");
  const fd = openSync(file, "w");
  logLine(id, `pnpm install --frozen-lockfile (cwd ${worktree})`);
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const output = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  if (result.error) return { ok: false, tail: `pnpm не запускается: ${result.error.code ?? result.error.message}` };
  if (result.status === 0) return { ok: true };
  const lines = output.trimEnd().split("\n");
  return { ok: false, tail: lines.slice(-INSTALL_TAIL).join("\n") };
}

function removeCreated(id, branch, worktree, created) {
  if (created.worktree) {
    logLine(id, `git worktree remove --force ${worktree}`);
    tryGit(["worktree", "remove", "--force", worktree]);
  }
  if (created.branch) {
    logLine(id, `git branch -D ${branch}`);
    tryGit(["branch", "-D", "--quiet", branch]);
  }
  tryGit(["worktree", "prune"]);
}

function prepare(task, primaryFolder) {
  const { id, title } = task;
  const branch = `${id.toLowerCase()}-${slugify(title)}`;
  const worktree = join(primaryFolder, ".claude/worktrees", branch);
  const created = { branch: false, worktree: false };
  const fail = (message) => {
    process.stdout.write(`${message}\n`);
    removeCreated(id, branch, worktree, created);
    process.exitCode = 1;
  };

  const added = runLogged(id, "git", ["worktree", "add", "--no-track", "-b", branch, worktree, TARGET]);
  if (added.status !== 0) return fail(`${id}: git worktree add не удался: ${oneLine(added.stderr)}`);
  created.branch = true;
  created.worktree = true;

  const checked = runLogged(id, process.execPath, [CHECK_SPEC, id, "--root", worktree], { cwd: primaryFolder });
  if (checked.status !== 0)
    return fail(`${checked.stdout}${checked.stderr}`.trimEnd() || `${id}: check-spec.mjs завершился с ошибкой`);

  const installed = installDependencies(id, worktree);
  if (!installed.ok)
    return fail(`${id}: pnpm install --frozen-lockfile не удался. Последние ${INSTALL_TAIL} строк:\n${installed.tail}`);

  try {
    createTask(id, { title, branch, worktree, reason: "ветка и worktree готовы" });
  } catch (error) {
    return fail(
      error instanceof StateBusyError ? "Состояние занято" : `${id}: запись состояния не удалась: ${error.message}`,
    );
  }
  process.stdout.write(`${id}: подготовлена\nВетка: ${branch}\nWorktree: ${worktree}\n`);
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const [command, ...rest] = args;
  const wanted = rest.length === 1 ? /^SH-(\d+)$/i.exec(rest[0]) : null;
  if (command !== "run" || rest.length > 1 || (rest.length === 1 && !wanted)) {
    process.stderr.write("Использование: pnpm factory run [SH-NNN]\n");
    process.exitCode = 2;
    return;
  }

  if (!tryGit(["rev-parse", "--show-toplevel"]).ok) {
    process.stderr.write("Это не git-репозиторий\n");
    process.exitCode = 2;
    return;
  }
  // Основная папка: первая запись списка worktree. Все операции идут в ней, откуда бы ни запустили скрипт.
  const primaryFolder = listWorktrees()[0].path;
  process.chdir(primaryFolder);

  const fetched = tryGit(["fetch", "origin", "--quiet"]);
  if (!fetched.ok) {
    process.stdout.write(`git fetch origin не удался: ${oneLine(fetched.stderr)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!tryGit(["rev-parse", "--verify", "--quiet", TARGET]).ok) {
    process.stdout.write(`Нет ссылки ${TARGET}\n`);
    process.exitCode = 1;
    return;
  }

  const tasks = readOriginTasks();
  const statuses = new Map(tasks.map((task) => [task.id, task.status]));
  const context = readContext();

  if (wanted) {
    const id = `SH-${wanted[1]}`;
    const task = tasks.find((item) => item.id === id);
    if (!task) {
      process.stdout.write(`${id} не запущена: нет в ${TARGET}\n`);
      process.exitCode = 1;
      return;
    }
    const { reasons } = blockers(task, statuses, context);
    if (reasons.length > 0) {
      process.stdout.write(`${id} не запущена: ${reasons.join("; ")}\n`);
      process.exitCode = 1;
      return;
    }
    prepare(task, primaryFolder);
    return;
  }

  const candidates = [];
  const waiting = [];
  for (const task of tasks.filter((item) => item.status === "Ready")) {
    const { reasons, waiting: waits } = blockers(task, statuses, context);
    if (reasons.length === 0) candidates.push(task);
    else if (waits) waiting.push(task);
  }
  const byNumber = (a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3));
  candidates.sort(byNumber);
  waiting.sort(byNumber);

  printList(candidates, waiting, statuses);
  if (candidates.length === 0) {
    process.stdout.write("Задач в Ready нет\n");
    return;
  }
  const chosen = await choose(candidates);
  if (!chosen) {
    process.stdout.write("Ничего не запущено\n");
    return;
  }
  prepare(chosen, primaryFolder);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
