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
// 5. После подготовки (или для задачи на этапе «подготовлена») фабрика запускает воркер `claude -p --agent sh-worker`
//    в worktree задачи и разбирает его JSON-ответ кодом: этап «готово», «стоп» или «ошибка» (SH-098).
//    Без --foreground воркера ведёт фоновый процесс `node scripts/factory.mjs _worker SH-NNN`, команда сразу завершается.
//    Не больше двух задач с живым фоновым процессом. Этап, pid и лимит проверяются при записи «в работе» под блокировкой.
//    Таймаут claude и бюджет задают FACTORY_WORKER_TIMEOUT_MIN и FACTORY_WORKER_BUDGET_USD (scripts/lib/factory-tools.mjs).
// Состояние: scripts/lib/factory-state.mjs. Права воркера: scripts/lib/factory-tools.mjs. Окружение: scripts/lib/local-env.mjs.
// Коды выхода: 0 — задача подготовлена и воркер запущен или ничего не запущено по выбору; 1 — задача не запущена; 2 — неверный вызов.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTask } from "./lib/backlog-task.mjs";
import {
  createTask,
  logLine,
  readState,
  StateBusyError,
  setStage,
  stateDir,
  updateTask,
} from "./lib/factory-state.mjs";
import { WORKER_DISALLOWED, workerAllowed, workerBudgetUsd, workerTimeoutMs } from "./lib/factory-tools.mjs";
import { listWorktrees, tryGit } from "./lib/git.mjs";
import { readLocalEnv } from "./lib/local-env.mjs";

const TARGET = "origin/main";
const CHECK_SPEC = fileURLToPath(new URL("./check-spec.mjs", import.meta.url));
const SLUG_MAX = 30;
const SLUG_WORDS = 3;
const INSTALL_TAIL = 20;
const FACTORY = fileURLToPath(import.meta.url);
const MAX_LIVE = 2;
const START_WAIT_SECONDS = 15;
const REPLY_MAX_BUFFER = 256 * 1024 * 1024;

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

// Каталоги задач в origin/main. Кандидаты берутся только из первого; остальные нужны, чтобы определить статус зависимости.
const TASK_DIR = "backlog/tasks/";
const ARCHIVE_DIRS = ["backlog/archive/tasks/", "backlog/completed/"];

// Задачи из каталога dir в origin/main: файлы читаются через git, рабочая папка не участвует.
// Каталога нет в origin/main: это не ошибка, список пуст.
function readOriginTasks(dir) {
  const listed = tryGit(["ls-tree", "-z", "--name-only", TARGET, dir]);
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

// Время старта процесса в ISO (точность до секунды), по `ps -o lstart=`. Нет процесса или нет ps — пустая строка.
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) return "";
  const time = new Date(result.stdout.trim());
  return Number.isNaN(time.getTime()) ? "" : time.toISOString();
}

// Процесс записи жив: pid есть, время старта записано и совпадает с временем старта процесса с этим pid.
// Совпадение отсекает чужой процесс, который получил тот же pid после перезапуска системы.
export function isAlive(record) {
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || !record.pid_started_at) return false;
  return processStartedAt(pid) === record.pid_started_at;
}

const reasonOf = (error) => (error instanceof Error ? error.message : String(error));

// Первая непустая строка текста после обрезки пробелов.
const firstLine = (text) =>
  String(text)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

const TAGGED = /^(ГОТОВО|СТОП|ЗАМЕЧАНИЯ) (SH-\d+)/;

// Этап и причина по тексту `result`: первая непустая строка сверяется с ID задачи.
function classifyResult(result, taskId) {
  const line = firstLine(result);
  if (line === `ГОТОВО ${taskId}`) return { stage: "готово", reason: "" };
  if (line.startsWith(`СТОП ${taskId}:`)) return { stage: "стоп", reason: line };
  // `ЗАМЕЧАНИЯ SH-NNN` — вопрос владельцу о попутных замечаниях, владелец отвечает на него как на `СТОП`.
  if (line === `ЗАМЕЧАНИЯ ${taskId}`) return { stage: "стоп", reason: line };
  const tagged = TAGGED.exec(line);
  if (tagged && tagged[2] !== taskId) return { stage: "ошибка", reason: "чужой ID" };
  return { stage: "ошибка", reason: "неизвестный ответ" };
}

// Разбор ответа воркера без модели. error — ошибка запуска процесса (нет claude в PATH и т. п.).
// Сначала проверяются причины ошибки по порядку, `result` разбирается, только если ни одна не сработала.
// Стоимость, отказы и session_id берутся из валидного JSON при любой причине.
export function parseWorkerReply({ stdout, code = 0, error, taskId, sessionId }) {
  let json = null;
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    // Невалидный JSON: json остаётся null.
  }
  const cost = Number(json?.total_cost_usd);
  const base = {
    cost: json && Number.isFinite(cost) ? cost : 0,
    denials: Array.isArray(json?.permission_denials) ? json.permission_denials : [],
    sessionReady: json !== null && json.session_id === sessionId,
  };
  const failed = (reason) => ({ stage: "ошибка", reason, ...base });

  if (error) return failed(`claude не запустился: ${reasonOf(error)}`);
  if (json === null) return failed("невалидный JSON");
  if (typeof json.subtype === "string" && json.subtype.startsWith("error"))
    return failed(`ошибка claude: ${json.subtype}`);
  if (json.is_error === true) return failed("is_error");
  if (code !== 0) return failed(`код ${code}`);
  if (typeof json.result !== "string") return failed("нет result");
  return { ...classifyResult(json.result, taskId), ...base };
}

// Пишет результат разбора в запись: этап и reason, стоимость прибавляется, denials заменяются,
// session_ready только поднимается. pid и pid_started_at не трогает: их очищает фоновый процесс при выходе.
export function applyWorkerReply(id, reply) {
  return setStage(id, reply.stage, reply.reason, (task) => ({
    cost_usd: task.cost_usd + (Number(reply.cost) || 0),
    denials: Array.isArray(reply.denials) ? reply.denials : [],
    session_ready: task.session_ready || reply.sessionReady === true,
  }));
}

// Пишет ответ в папку задачи как `NNN-<role>.json`, где NNN — максимальный номер файлов ответов плюс один.
// Невалидный stdout сохраняется как есть. Возвращает путь файла.
export function saveReply(id, role, stdout) {
  const dir = join(stateDir(), id);
  mkdirSync(dir, { recursive: true });
  for (;;) {
    const numbers = readdirSync(dir)
      .map((name) => /^(\d+)-.+\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const file = join(dir, `${String(Math.max(0, ...numbers) + 1).padStart(3, "0")}-${role}.json`);
    try {
      writeFileSync(file, stdout ?? "", { flag: "wx" });
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

// Аргументы `claude -p` для воркера задачи (docs/process.md §7.1). Каждый список правил — один аргумент.
function workerArgs(record) {
  return [
    "-p",
    `Новый старт ${record.id}. Ветка: ${record.branch}.`,
    "--agent",
    "sh-worker",
    "--session-id",
    record.session_id,
    "--name",
    `Фабрика ${record.id}`,
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    workerAllowed(record.worktree).join(","),
    "--disallowedTools",
    WORKER_DISALLOWED.join(","),
    "--max-budget-usd",
    String(workerBudgetUsd()),
  ];
}

const quoteArg = (arg) => (/^[\w./:=,()*@%+-]+$/.test(arg) ? arg : JSON.stringify(arg));

// Отказ занять задачу: этап не «подготовлена», живой pid или лимит живых процессов.
class ClaimError extends Error {}

// Переводит запись в «в работе» с pid и временем старта этого процесса. Проверки этапа, pid и лимита живых
// процессов идут в той же записи под одной блокировкой состояния: два процесса не пройдут проверку вместе.
// Новый session_id пишется там же: второй запуск не подменит session_id работающего воркера. Возвращает запись.
function claimWorker(id) {
  const startedAt = processStartedAt(process.pid);
  return setStage(id, "в работе", "воркер запущен", (current) => {
    if (current.stage !== "подготовлена")
      throw new ClaimError(`${id} не запущена: этап «${current.stage}», нужен «подготовлена»`);
    if (isAlive(current)) throw new ClaimError(`${id} не запущена: у записи живой процесс ${current.pid}`);
    const live = Object.values(readState().tasks)
      .filter((record) => record.id !== id && isAlive(record))
      .map((record) => record.id);
    if (live.length >= MAX_LIVE)
      throw new ClaimError(
        `${id} не запущена: живой фоновый процесс у ${live.length} задач (${live.join(", ")}), максимум ${MAX_LIVE}`,
      );
    return { pid: process.pid, pid_started_at: startedAt, session_id: randomUUID() };
  });
}

// Выполняет воркера в текущем процессе: проверка и этап «в работе» с pid (одна запись под блокировкой, до запуска
// claude), запуск claude с таймаутом, разбор и запись ответа. В конце pid очищается при любом исходе.
// Возвращает false, если запуск отклонён: причина напечатана, код выхода 1.
function runWorker(id, primaryFolder) {
  if (!readState().tasks[id]) throw new Error(`нет записи фабрики для ${id}`);
  let record;
  try {
    record = claimWorker(id);
  } catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    logLine(id, error.message);
    process.stdout.write(`${error.message}\n`);
    process.exitCode = 1;
    return false;
  }
  try {
    const args = workerArgs(record);
    logLine(id, `claude ${args.map(quoteArg).join(" ")} (cwd ${record.worktree})`);
    const env = { ...process.env, ...readLocalEnv(primaryFolder), ...readLocalEnv(record.worktree) };
    const timeoutMs = workerTimeoutMs();
    const result = spawnSync("claude", args, {
      cwd: record.worktree,
      env,
      encoding: "utf8",
      maxBuffer: REPLY_MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = result.stdout ?? "";
    saveReply(id, "worker", stdout);
    const stderr = firstLine(result.stderr ?? "");
    if (stderr) logLine(id, `claude stderr: ${stderr.slice(0, 200)}`);
    const reply = parseWorkerReply({
      stdout,
      code: result.status,
      error: result.error,
      taskId: id,
      sessionId: record.session_id,
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    applyWorkerReply(
      id,
      timedOut ? { ...reply, stage: "ошибка", reason: `таймаут ${timeoutMs / 60_000} мин, claude остановлен` } : reply,
    );
  } catch (error) {
    try {
      setStage(id, "ошибка", `фабрика: ${reasonOf(error)}`);
    } catch {
      // Состояние недоступно: остаётся этап «в работе» и мёртвый pid.
    }
  } finally {
    try {
      updateTask(id, { pid: null, pid_started_at: "" });
    } catch {
      // Запись не обновить: мёртвый pid не считается живым (isAlive сверяет время старта).
    }
  }
  return true;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Запускает воркера для записи на этапе «подготовлена». Без foreground — фоновый процесс `_worker` и сразу выход.
async function launchWorker(record, primaryFolder, foreground) {
  const { id } = record;
  if (!existsSync(record.worktree)) {
    process.stdout.write(`${id} не запущена: нет worktree ${record.worktree}\n`);
    process.exitCode = 1;
    return;
  }
  const logPath = join(stateDir(), id, "log.txt");
  process.stdout.write(`${id}: воркер запущен\nВетка: ${record.branch}\nЖурнал: ${logPath}\n`);

  if (foreground) {
    if (!runWorker(id, primaryFolder)) return;
    const done = readState().tasks[id];
    process.stdout.write(`${id}: ${done.stage}${done.reason ? `; ${done.reason}` : ""}\n`);
    return;
  }

  logLine(id, `фоновый процесс: node scripts/factory.mjs _worker ${id}`);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [FACTORY, "_worker", id], {
    cwd: primaryFolder,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let failure = "";
  child.once("error", (error) => {
    failure = reasonOf(error);
  });
  child.once("exit", (code) => {
    failure ||= `процесс вышел с кодом ${code}`;
  });
  child.unref();
  // Выходим, когда процесс _worker записал этап «в работе»: быстрый ответ claude не обгоняет эту запись.
  const deadline = Date.now() + START_WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (readState().tasks[id]?.stage !== "подготовлена") return;
    if (failure) break;
    await sleep(50);
  }
  if (readState().tasks[id]?.stage !== "подготовлена") return;
  process.stdout.write(`${id}: фоновый процесс не начал работу${failure ? ` (${failure})` : ""}. Журнал: ${logPath}\n`);
  process.exitCode = 1;
}

// Не больше MAX_LIVE задач с живым фоновым процессом. false — лимит исчерпан, причина напечатана, код 1.
function checkLimit() {
  const live = Object.values(readState().tasks)
    .filter((record) => isAlive(record))
    .map((record) => record.id);
  if (live.length < MAX_LIVE) return true;
  process.stdout.write(
    `Не запущено: живой фоновый процесс у ${live.length} задач (${live.join(", ")}), максимум ${MAX_LIVE}\n`,
  );
  process.exitCode = 1;
  return false;
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

// Готовит ветку, worktree и запись. Возвращает запись на этапе «подготовлена» или ничего при ошибке (код 1).
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
  return readState().tasks[id];
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const foreground = args.includes("--foreground");
  const [command, ...rest] = args.filter((arg) => arg !== "--foreground");
  const wanted = rest.length === 1 ? /^SH-(\d+)$/i.exec(rest[0]) : null;
  const internal = command === "_worker" && wanted;
  if (!internal && (command !== "run" || rest.length > 1 || (rest.length === 1 && !wanted))) {
    process.stderr.write("Использование: pnpm factory run [SH-NNN] [--foreground]\n");
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

  if (internal) {
    runWorker(`SH-${wanted[1]}`, primaryFolder);
    return;
  }
  if (!checkLimit()) return;

  // Задача на этапе «подготовлена»: ветка и worktree готовы, fetch, check-spec и install не нужны.
  const prepared = wanted ? readState().tasks[`SH-${wanted[1]}`] : undefined;
  if (prepared?.stage === "подготовлена") return launchWorker(prepared, primaryFolder, foreground);

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

  const tasks = readOriginTasks(TASK_DIR);
  // Статус зависимости определяем и для архивных задач; запись из backlog/tasks перекрывает архивную.
  const statuses = new Map([...ARCHIVE_DIRS.flatMap(readOriginTasks), ...tasks].map((task) => [task.id, task.status]));
  const context = readContext();

  const launch = (record) => (record ? launchWorker(record, primaryFolder, foreground) : undefined);

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
    return launch(prepare(task, primaryFolder));
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
  return launch(prepare(chosen, primaryFolder));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
