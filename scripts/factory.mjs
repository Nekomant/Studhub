#!/usr/bin/env node
// Фабрика-оркестратор (ADR 0011, docs/process.md §7.1). Скрипт без модели: правила выполняет код.
// Запускается из любой папки клона; основная папка берётся из первой записи `git worktree list --porcelain`.
// Команды:
//   ready SH-NNN    выбор и проверка задачи, ветка, worktree, права и модель воркера, бриф подсессии
//   next SH-NNN     проверки DoD, ревьюер, push, PR, ожидание CI
//   merge SH-NNN    после добра владельца: ретро, статус Merged, squash-слияние, уборка
//   status          текущий этап каждой задачи
// Запасной вариант (ADR 0010): run/answer/continue/drop/list и сводка без аргументов. Запуск агентов — `dsh headless`.
// Состояние: scripts/lib/factory-state.mjs. Права и роли: scripts/lib/factory-tools.mjs. Окружение: scripts/lib/local-env.mjs.
// Коды выхода: 0 — команда выполнена; 1 — задача не запущена/не слита; 2 — неверный вызов.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTask } from "./lib/backlog-task.mjs";
import {
  createTask,
  logLine,
  readState,
  removeTask,
  STAGES_RUNNING,
  STAGES_WAIT_OWNER,
  StateBusyError,
  setStage,
  stateDir,
  updateTask,
} from "./lib/factory-state.mjs";
import {
  agentInvocation,
  MODEL_PRICE_CNY_PER_MTOK,
  rightsAllowed,
  WORKER_DISALLOWED,
  workerAllowed,
  workerTimeoutMs,
} from "./lib/factory-tools.mjs";
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
      return shown.ok ? { ...parseTask(shown.stdout), file: path } : null;
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

// Разбор ответа агента без модели. error — ошибка запуска процесса (нет dsh в PATH и т. п.).
// Сначала проверяются причины ошибки по порядку, `result` разбирается, только если ни одна не сработала.
// Токены и session_id берутся из валидного JSON при любой причине.
export function parseWorkerReply({ stdout, code = 0, error, taskId, sessionId }) {
  let json = null;
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    // Невалидный JSON: json остаётся null.
  }
  const tokens = {
    input: Number(json?.usage?.input_tokens ?? 0),
    output: Number(json?.usage?.output_tokens ?? 0),
    reasoning: Number(json?.usage?.reasoning_tokens ?? 0),
  };
  const base = {
    tokens,
    sessionReady: json !== null && json.session_id === sessionId,
  };
  const failed = (reason) => ({ stage: "ошибка", reason, ...base });

  if (error) return failed(`dsh не запустился: ${reasonOf(error)}`);
  if (json === null) return failed("невалидный JSON");
  if (typeof json.subtype === "string" && json.subtype.startsWith("error"))
    return failed(`ошибка dsh: ${json.subtype}`);
  if (json.is_error === true) return failed("is_error");
  if (code !== 0) return failed(`код ${code}`);
  if (typeof json.result !== "string") return failed("нет result");
  return { ...classifyResult(json.result, taskId), ...base };
}

// Пишет результат разбора в запись: этап и reason, токены воркера прибавляются,
// session_ready только поднимается. pid и pid_started_at не трогает.
export function applyWorkerReply(id, reply) {
  return setStage(id, reply.stage, reply.reason, (task) => ({
    tokens: {
      ...task.tokens,
      worker: {
        input: (task.tokens?.worker?.input ?? 0) + (Number(reply.tokens?.input) || 0),
        output: (task.tokens?.worker?.output ?? 0) + (Number(reply.tokens?.output) || 0),
        reasoning: (task.tokens?.worker?.reasoning ?? 0) + (Number(reply.tokens?.reasoning) || 0),
      },
    },
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

// ---------------------------------------------------------------------------------------------------------------
// Запуск агентов через `dsh headless`. Модель и уровень материализуются в --patch-файл.

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

// Git-каталог worktree для флага --add-dir.
function resolveGitDir(worktree) {
  const result = spawnSync("git", ["-C", worktree, "rev-parse", "--git-dir"], { encoding: "utf8" });
  const dir = (result.stdout ?? "").trim();
  if (!dir) return join(worktree, ".git");
  return isAbsolute(dir) ? dir : join(worktree, dir);
}

// Файл --patch с моделью и уровнем reasoning (docs/process.md §7.1).
function writeModelPatch(model, effort) {
  const dir = mkdtempSync(join(tmpdir(), "factory-patch-"));
  const file = join(dir, "patch.yml");
  const config = `{ provider: 'deepseek-account', model: ${model}${effort ? `, reasoningEffort: ${effort}` : ""} }`;
  writeFileSync(file, `- name: '@deepseek-ai/dsh-agent-default-model'\n  config: ${config}\n`);
  return file;
}

// Запускает агента по логической спецификации agentInvocation и возвращает результат процесса.
function runHeadless(id, invocation, { worktree, primaryFolder }) {
  const model = valueAfter(invocation.args, "--model");
  const effort = valueAfter(invocation.args, "--effort");
  const patch = writeModelPatch(model, effort);
  const args = [...invocation.args, "--add-dir", resolveGitDir(worktree), "--patch", patch, invocation.prompt];
  logLine(id, `dsh ${args.map(quoteArg).join(" ")} (cwd ${worktree})`);
  const env = { ...process.env, ...readLocalEnv(primaryFolder), ...readLocalEnv(worktree) };
  const result = spawnSync("dsh", args, {
    cwd: worktree,
    env,
    encoding: "utf8",
    maxBuffer: REPLY_MAX_BUFFER,
    timeout: workerTimeoutMs(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status, error: result.error };
}

// Разбор ответа dsh headless без привязки к роли: ok/причина + result + токены.
function parseAgentReply({ stdout, code = 0, error }) {
  let json = null;
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    // Невалидный JSON.
  }
  const usage = {
    input: Number(json?.usage?.input_tokens ?? 0),
    output: Number(json?.usage?.output_tokens ?? 0),
    reasoning: Number(json?.usage?.reasoning_tokens ?? 0),
  };
  if (error) return { ok: false, reason: `dsh не запустился: ${reasonOf(error)}`, usage };
  if (json === null) return { ok: false, reason: "невалидный JSON", usage };
  if (typeof json.subtype === "string" && json.subtype.startsWith("error"))
    return { ok: false, reason: `ошибка dsh: ${json.subtype}`, usage };
  if (json.is_error === true) return { ok: false, reason: "is_error", usage };
  if (code !== 0) return { ok: false, reason: `код ${code}`, usage };
  if (typeof json.result !== "string") return { ok: false, reason: "нет result", usage };
  return { ok: true, result: json.result, usage };
}

// Прибавляет токены агента к разбивке записи.
function addTokens(id, agent, usage) {
  updateTask(id, (task) => ({
    tokens: {
      ...task.tokens,
      [agent]: {
        input: (task.tokens?.[agent]?.input ?? 0) + (Number(usage.input) || 0),
        output: (task.tokens?.[agent]?.output ?? 0) + (Number(usage.output) || 0),
        reasoning: (task.tokens?.[agent]?.reasoning ?? 0) + (Number(usage.reasoning) || 0),
      },
    },
  }));
}

// Модель и уровень воркера из поля «Модель» задачи: pro → deepseek-v4-pro + high, flash → deepseek-flash.
const workerModel = (model) => (model === "flash" ? "deepseek-flash" : "deepseek-v4-pro");
const workerEffortFor = (model) => (model === "flash" ? undefined : "high");

const modelName = (model) => workerModel(model);

// ---------------------------------------------------------------------------------------------------------------
// Уведомления macOS и живучесть фоновых процессов.

const DEAD_REASON = "процесс завершился без ответа";
const NOTIFY_MAX = 100;
const NOTIFY_SCRIPT = [
  "-e",
  "on run argv",
  "-e",
  'display notification (item 1 of argv) with title "Фабрика"',
  "-e",
  "end run",
];

// Уведомление macOS, когда задача перешла на этап, который ждёт владельца. Текст идёт отдельным аргументом osascript.
function notify(id, stage, reason) {
  if (!STAGES_WAIT_OWNER.includes(stage)) return;
  const detail = stage === "стоп" ? firstLine(reason) : String(reason ?? "").trim();
  const text = Array.from([`${id} · ${stage}`, detail].filter(Boolean).join(" · "))
    .slice(0, NOTIFY_MAX)
    .join("");
  const result = spawnSync("osascript", [...NOTIFY_SCRIPT, text], { stdio: "ignore", timeout: 10_000 });
  if (!result.error && result.status === 0) return;
  try {
    logLine(id, `уведомление: ${text}`);
  } catch {
    // Журнал недоступен.
  }
}

// Ставит этап и шлёт уведомление, если этап ждёт владельца.
function moveStage(id, stage, reason, extra) {
  const task = setStage(id, stage, reason, extra);
  notify(id, stage, reason);
  return task;
}

class Skip extends Error {}

// Задача на этапе, где работает процесс, а процесс не жив: этап «ошибка» с причиной и уведомление.
function markDeadWorkers() {
  for (const record of Object.values(readState().tasks)) {
    if (!STAGES_RUNNING.includes(record.stage) || isAlive(record)) continue;
    try {
      moveStage(record.id, "ошибка", DEAD_REASON, (current) => {
        if (!STAGES_RUNNING.includes(current.stage) || isAlive(current)) throw new Skip();
        return { pid: null, pid_started_at: "" };
      });
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Запасной вариант: run/answer/continue — воркер в фоне через dsh headless.

const MODES = {
  start: { from: "подготовлена", command: "_worker" },
  answer: { from: "стоп", command: "_answer" },
  continue: { from: "ошибка", command: "_continue" },
};

// Логическая спецификация вызова воркера. resume — продолжение сессии записи (--session-id уже задан).
function workerInvocation(record, mode, resume) {
  const prompt = resume
    ? mode.kind === "answer"
      ? `Продолжение ${record.id}. Ответ владельца: ${mode.text}`
      : `Продолжение ${record.id}.`
    : `Новый старт ${record.id}. Ветка: ${record.branch}.`;
  return agentInvocation("sh-worker", {
    sessionId: record.session_id,
    model: workerModel(record.model),
    effort: workerEffortFor(record.model),
    prompt: `${prompt} (sh-worker)`,
  });
}

const quoteArg = (arg) => (/^[\w./:=,()*@%+-]+$/.test(arg) ? arg : JSON.stringify(arg));

// Отказ занять задачу: этап не «подготовлена», живой pid или лимит живых процессов.
class ClaimError extends Error {}

// Переводит запись в «в работе» с pid и временем старта этого процесса. Новый session_id получают новый старт
// и повтор без готовой сессии; продолжение оставляет session_id записи.
function claimWorker(id, mode) {
  const startedAt = processStartedAt(process.pid);
  const from = MODES[mode.kind].from;
  return setStage(id, "в работе", "воркер запущен", (current) => {
    if (current.stage !== from) throw new ClaimError(`${id} не запущена: этап «${current.stage}», нужен «${from}»`);
    if (isAlive(current)) throw new ClaimError(`${id} не запущена: у записи живой процесс ${current.pid}`);
    const live = Object.values(readState().tasks)
      .filter((record) => record.id !== id && isAlive(record))
      .map((record) => record.id);
    if (live.length >= MAX_LIVE)
      throw new ClaimError(
        `${id} не запущена: живой фоновый процесс у ${live.length} задач (${live.join(", ")}), максимум ${MAX_LIVE}`,
      );
    const fresh = mode.kind === "start" || (mode.kind === "continue" && !current.session_ready);
    return {
      pid: process.pid,
      pid_started_at: startedAt,
      session_id: fresh ? randomUUID() : current.session_id,
    };
  });
}

// Выполняет воркера в текущем процессе: этап «в работе» с pid, запуск dsh headless, разбор и запись ответа.
function runWorker(id, primaryFolder, mode = { kind: "start" }) {
  if (!readState().tasks[id]) throw new Error(`нет записи фабрики для ${id}`);
  let record;
  try {
    record = claimWorker(id, mode);
  } catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    logLine(id, error.message);
    process.stdout.write(`${error.message}\n`);
    process.exitCode = 1;
    return false;
  }
  try {
    const resume = mode.kind === "answer" || (mode.kind === "continue" && record.session_ready);
    const invocation = workerInvocation(record, mode, resume);
    const result = runHeadless(id, invocation, { worktree: record.worktree, primaryFolder });
    const stdout = result.stdout;
    saveReply(id, "worker", stdout);
    const stderr = firstLine(result.stderr);
    if (stderr) logLine(id, `dsh stderr: ${stderr.slice(0, 200)}`);
    const reply = parseWorkerReply({
      stdout,
      code: result.code,
      error: result.error,
      taskId: id,
      sessionId: record.session_id,
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    const final = timedOut
      ? { ...reply, stage: "ошибка", reason: `таймаут ${workerTimeoutMs() / 60_000} мин, dsh остановлен` }
      : reply;
    applyWorkerReply(id, final);
    notify(id, final.stage, final.reason);
  } catch (error) {
    try {
      moveStage(id, "ошибка", `фабрика: ${reasonOf(error)}`);
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

// Запускает воркера для записи на этапе mode.from. Без foreground — фоновый процесс и сразу выход.
async function launchWorker(record, primaryFolder, foreground, mode = { kind: "start" }) {
  const { id } = record;
  const from = MODES[mode.kind].from;
  if (!existsSync(record.worktree)) {
    process.stdout.write(`${id} не запущена: нет worktree ${record.worktree}\n`);
    process.exitCode = 1;
    return;
  }
  const logPath = join(stateDir(), id, "log.txt");
  process.stdout.write(`${id}: воркер запущен\nВетка: ${record.branch}\nЖурнал: ${logPath}\n`);

  if (foreground) {
    if (!runWorker(id, primaryFolder, mode)) return;
    const done = readState().tasks[id];
    process.stdout.write(`${id}: ${done.stage}${done.reason ? `; ${done.reason}` : ""}\n`);
    return;
  }

  const childArgs = [MODES[mode.kind].command, id, ...(mode.kind === "answer" ? [mode.text] : [])];
  logLine(id, `фоновый процесс: node scripts/factory.mjs ${MODES[mode.kind].command} ${id}`);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [FACTORY, ...childArgs], {
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
  const moved = () => {
    const current = readState().tasks[id];
    return current?.stage !== from || current.stage_changed_at !== record.stage_changed_at;
  };
  const deadline = Date.now() + START_WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (moved()) return;
    if (failure) break;
    await sleep(50);
  }
  if (moved()) return;
  process.stdout.write(`${id}: фоновый процесс не начал работу${failure ? ` (${failure})` : ""}. Журнал: ${logPath}\n`);
  process.exitCode = 1;
}

// Не больше MAX_LIVE задач с живым фоновым процессом.
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

// ---------------------------------------------------------------------------------------------------------------
// Подготовка задачи (общая для ready и запасного run).

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

// Права и модель воркера в настройках worktree (.claude/settings.local.json).
function writeWorktreeSettings(worktree, task) {
  const settings = {
    permissions: {
      allow: [...workerAllowed(worktree), ...rightsAllowed(task.rights)],
      deny: WORKER_DISALLOWED,
    },
    model: modelName(task.model),
  };
  const dir = join(worktree, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.local.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

// Готовит ветку, worktree, права, модель и запись. Возвращает запись на этапе «подготовлена» или ничего при ошибке.
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
    createTask(id, {
      title,
      branch,
      worktree,
      model: task.model,
      rights: task.rights,
      reason: "ветка и worktree готовы",
    });
  } catch (error) {
    return fail(
      error instanceof StateBusyError ? "Состояние занято" : `${id}: запись состояния не удалась: ${error.message}`,
    );
  }
  process.stdout.write(`${id}: подготовлена\nВетка: ${branch}\nWorktree: ${worktree}\n`);
  return readState().tasks[id];
}

// Бриф подсессии: ID, ветка, worktree, модель и права (docs/process.md §7.1).
function printBrief(task, record) {
  process.stdout.write(
    [
      `${task.id}: бриф`,
      `Ветка: ${record.branch}`,
      `Worktree: ${record.worktree}`,
      `Модель: ${modelName(task.model)}`,
      `Права: ${task.rights.length > 0 ? task.rights.join(", ") : "базовые"}`,
    ].join("\n") + "\n",
  );
}

// ---------------------------------------------------------------------------------------------------------------
// factory ready: выбор и проверка задачи, актуальность по «Затрагивает», подготовка и бриф.

// Файлы из поля «Затрагивает», которые изменились после коммита, где задача перешла в Ready.
function changedSinceReady(task) {
  const changed = [];
  if (!task.affects?.length) return changed;
  const commit = tryGit(["log", "-1", "--format=%H", TARGET, "--", task.file]);
  if (!commit.ok) return changed;
  const base = commit.stdout.trim();
  for (const file of task.affects) {
    const atBase = tryGit(["rev-parse", `${base}:${file}`]);
    const atHead = tryGit(["rev-parse", `${TARGET}:${file}`]);
    if (atBase.ok !== atHead.ok || atBase.stdout !== atHead.stdout) changed.push(file);
  }
  return changed;
}

async function readyCommand(task, primaryFolder) {
  const changed = changedSinceReady(task);
  if (changed.length > 0) {
    for (const file of changed) process.stdout.write(`${file}\n`);
    const answer = await ask("Подготовить задачу, несмотря на изменения? [y/n] ");
    if (!/^(y|yes)$/i.test(answer)) {
      process.stdout.write("Задача не подготовлена\n");
      return;
    }
  }
  const record = prepare(task, primaryFolder);
  if (record) {
    writeWorktreeSettings(record.worktree, task);
    printBrief(task, record);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// factory next: проверки DoD, красный коммит, ревьюер, PR и CI.

const DOD_CHECKS = [
  { name: "тесты", args: ["test"] },
  { name: "линт", args: ["exec", "biome", "ci", "."] },
  { name: "типы", args: ["exec", "tsc", "-b"] },
  { name: "критерии", args: ["ac:check"] },
];

function runDoDChecks(record) {
  const errors = [];
  let ok = true;
  for (const check of DOD_CHECKS) {
    logLine(record.id, `pnpm ${check.args.join(" ")} (cwd ${record.worktree})`);
    const result = spawnSync("pnpm", check.args, {
      cwd: record.worktree,
      encoding: "utf8",
      maxBuffer: REPLY_MAX_BUFFER,
    });
    if (result.status === 0) continue;
    ok = false;
    errors.push(`проверка ${check.name} не прошла:`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (output) for (const line of output.split("\n")) errors.push(line);
  }
  return { ok, errors };
}

const isTestFile = (path) =>
  /(^|\/)(tests?|__tests__|tools\/tests)\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);

// Проверка красного коммита: первый коммит ветки после origin/main должен содержать только тестовые файлы,
// и после него нельзя менять проверки в тестах (тогда нужен sh-verifier).
function checkRedCommit(record) {
  const wt = record.worktree;
  const base = oneLine(tryGit(["-C", wt, "merge-base", TARGET, "HEAD"]).stdout);
  const commits = tryGit(["-C", wt, "log", "--format=%H", "--reverse", `${base}..HEAD`])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = [];
  let verifier = false;
  if (commits.length === 0) return { ok: true, verifier, errors };
  const filesOf = (commit) =>
    tryGit(["-C", wt, "show", "--name-only", "--format=", commit])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const nonTest = filesOf(commits[0]).filter((file) => !isTestFile(file));
  if (nonTest.length > 0) errors.push(`в красном коммите есть не-тестовые файлы: ${nonTest.join(", ")}`);
  for (const commit of commits.slice(1)) {
    if (filesOf(commit).some(isTestFile)) {
      verifier = true;
      errors.push("после красного коммита изменены проверки в тестах");
      break;
    }
  }
  return { ok: errors.length === 0, verifier, errors };
}

// Вердикт ревьюера: первая строка «чисто» или «блокирует: N».
function parseReviewerVerdict(result) {
  const line = firstLine(result);
  if (line === "чисто") return { verdict: "clean" };
  const blocked = /^блокирует:\s*(\d+)/.exec(line);
  if (blocked) return { verdict: "blocked", count: Number(blocked[1]) };
  return { verdict: "unknown" };
}

function writeReviewFile(record, result) {
  const dir = join(record.worktree, "docs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `review-${record.id}.md`);
  writeFileSync(file, `${result}\n`);
  return file;
}

function pushBranch(record) {
  const pushed = tryGit(["-C", record.worktree, "push", "-q", "origin", record.branch]);
  if (!pushed.ok) logLine(record.id, `git push origin ${record.branch}: ${pushed.stderr}`);
  return pushed.ok;
}

function createPr(record) {
  const result = runLogged(record.id, "gh", ["pr", "create", "--fill"], { cwd: record.worktree });
  return oneLine(result.stdout);
}

function checkCi(record, prUrl) {
  const result = runLogged(record.id, "gh", ["pr", "checks", prUrl], { cwd: record.worktree });
  let state = "SUCCESS";
  let log = "";
  try {
    const parsed = JSON.parse(result.stdout);
    state = String(parsed.state ?? "SUCCESS");
    log = String(parsed.log ?? "");
  } catch {
    // Не JSON — считаем зелёным, если процесс завершился успешно.
  }
  return { ok: state === "SUCCESS", log };
}

// Печать результата: первая строка — действие для воркера, вторая — фраза этапа, дальше — доп. строки.
function emitResult(action, stage, extraLines = []) {
  process.stdout.write(`${action}\n${stage}\n`);
  for (const line of extraLines) process.stdout.write(`${line}\n`);
}

async function nextCommand(id, primaryFolder) {
  const record = readState().tasks[id];
  if (!record) {
    process.stdout.write(`${id}: нет записи фабрики\n`);
    process.exitCode = 1;
    return;
  }
  const worktree = record.worktree;
  if (!existsSync(worktree)) {
    process.stdout.write(`${id}: нет worktree ${worktree}\n`);
    process.exitCode = 1;
    return;
  }

  const dod = runDoDChecks(record);
  if (!dod.ok) {
    emitResult("доработать", "проверки DoD", dod.errors);
    setStage(id, "проверки DoD", "проверки DoD не прошли");
    return;
  }

  const red = checkRedCommit(record);
  if (!red.ok) {
    if (red.verifier) {
      const verifier = agentInvocation("sh-verifier", {
        sessionId: randomUUID(),
        prompt: `sh-verifier Проверь ${id}`,
      });
      const result = runHeadless(id, verifier, { worktree, primaryFolder });
      const reply = parseAgentReply(result);
      addTokens(id, "verifier", reply.usage);
      saveReply(id, "verifier", result.stdout);
      if (!reply.ok) logLine(id, `sh-verifier: ${reply.reason}`);
    }
    emitResult("доработать", "красный коммит", red.errors);
    setStage(id, "красный коммит", red.errors.join("; "));
    return;
  }

  pushBranch(record);

  const reviewer = agentInvocation("sh-reviewer", {
    sessionId: randomUUID(),
    prompt: `sh-reviewer Проверь ${id}`,
  });
  const reviewResult = runHeadless(id, reviewer, { worktree, primaryFolder });
  saveReply(id, "reviewer", reviewResult.stdout);
  const reply = parseAgentReply(reviewResult);
  addTokens(id, "reviewer", reply.usage);
  if (!reply.ok) {
    emitResult("ошибка", "ревью", [reply.reason]);
    setStage(id, "ревью", reply.reason);
    return;
  }

  const verdict = parseReviewerVerdict(reply.result);
  if (verdict.verdict === "blocked") {
    const file = writeReviewFile(record, reply.result);
    updateTask(id, (task) => ({
      round: (task.round ?? 0) + 1,
      remarks_count: (task.remarks_count ?? 0) + verdict.count,
    }));
    emitResult(`доработать, замечания в файле ${file}`, "ревью");
    setStage(id, "ревью", "блокирует");
    return;
  }
  if (verdict.verdict !== "clean") {
    emitResult("ошибка", "ревью", ["неверный формат ответа ревьюера"]);
    setStage(id, "ревью", "неверный формат ответа ревьюера");
    return;
  }

  const prUrl = record.pr_url || createPr(record);
  updateTask(id, { pr_url: prUrl });
  const ci = checkCi(record, prUrl);
  if (!ci.ok) {
    emitResult("доработать", "CI", [ci.log || "красный CI"]);
    setStage(id, "CI", ci.log || "красный CI");
    return;
  }

  emitResult(`PR готов, замечаний: ${record.remarks_count ?? 0}`, "готов к ревью");
  setStage(id, "готов к ревью", "");
}

// ---------------------------------------------------------------------------------------------------------------
// factory merge: ретро, статус Merged, squash-слияние, уборка и статистика токенов.

function appendRetroEntry(record, entry) {
  const dir = join(record.worktree, "docs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "process-retro.md");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry.trim()}\n`);
  tryGit(["-C", record.worktree, "add", "docs/process-retro.md"]);
  tryGit(["-C", record.worktree, "commit", "-q", "-m", `chore(retro): ${record.id} ретро-анализ`]);
}

function commitMergedStatus(record) {
  const dir = join(record.worktree, "backlog", "tasks");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const file = names.find((name) => name.toLowerCase().startsWith(`${record.id.toLowerCase()} - `));
  if (!file) return;
  const path = join(dir, file);
  const text = readFileSync(path, "utf8");
  const updated = text.replace(/^status:\s*.*$/m, "status: Merged");
  if (updated === text) return;
  writeFileSync(path, updated);
  tryGit(["-C", record.worktree, "add", `backlog/tasks/${file}`]);
  tryGit(["-C", record.worktree, "commit", "-q", "-m", `chore(backlog): ${record.id} Merged`]);
}

function tokenCost(tokens) {
  let cost = 0;
  for (const agent of ["worker", "verifier", "reviewer", "retro"]) {
    const usage = tokens?.[agent] ?? {};
    const price = MODEL_PRICE_CNY_PER_MTOK[agentModel(agent)] ?? { input: 0, output: 0 };
    cost += ((Number(usage.input) || 0) * (price.input || 0) + (Number(usage.output) || 0) * (price.output || 0)) / 1e6;
  }
  return cost;
}

const agentModel = (agent) => (agent === "reviewer" ? "deepseek-v4-pro" : "deepseek-flash");

function tokenTotals(tokens) {
  const usage = { input: 0, output: 0, reasoning: 0 };
  for (const agent of ["worker", "verifier", "reviewer", "retro"]) {
    const part = tokens?.[agent] ?? {};
    usage.input += Number(part.input) || 0;
    usage.output += Number(part.output) || 0;
    usage.reasoning += Number(part.reasoning) || 0;
  }
  return { ...usage, total: usage.input + usage.output + usage.reasoning };
}

async function mergeCommand(id, primaryFolder) {
  const record = readState().tasks[id];
  if (!record) {
    process.stdout.write(`${id}: нет записи фабрики\n`);
    process.exitCode = 1;
    return;
  }
  const worktree = record.worktree;
  const ci = checkCi(record, record.pr_url);
  if (!ci.ok) {
    process.stdout.write(`Слияние не выполнено: CI не зелёный${ci.log ? ` — ${ci.log}` : ""}\n`);
    process.exitCode = 1;
    return;
  }

  const retro = agentInvocation("sh-retro", { sessionId: randomUUID(), prompt: `sh-retro ${id}` });
  const retroResult = runHeadless(id, retro, { worktree, primaryFolder });
  saveReply(id, "retro", retroResult.stdout);
  const retroReply = parseAgentReply(retroResult);
  addTokens(id, "retro", retroReply.usage);
  if (retroReply.ok && retroReply.result.trim() && retroReply.result.trim() !== "чисто") {
    appendRetroEntry(record, retroReply.result);
  }
  commitMergedStatus(record);
  pushBranch(record);

  process.stdout.write(`gh pr merge ${record.pr_url} --squash\n`);
  runLogged(id, "gh", ["pr", "merge", record.pr_url, "--squash"], { cwd: worktree });

  // Уборка: worktree, ветка, основная папка на origin/main.
  tryGit(["worktree", "remove", "--force", worktree]);
  tryGit(["worktree", "prune"]);
  tryGit(["branch", "-D", "--quiet", record.branch]);
  tryGit(["fetch", "origin", "--quiet"]);
  tryGit(["merge", "--ff-only", "origin/main"]);

  const totals = tokenTotals(readState().tasks[id]?.tokens);
  const cost = tokenCost(readState().tasks[id]?.tokens);
  process.stdout.write(
    `Токены: ${totals.total} (input ${totals.input}, output ${totals.output}, reasoning ${totals.reasoning}), стоимость ~¥${cost.toFixed(2)}\n`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// factory status, сводка, list, answer, continue, drop.

function statusCommand() {
  const records = Object.values(readState().tasks);
  if (records.length === 0) {
    process.stdout.write("Фабрика пуста\n");
    return;
  }
  const byAge = (a, b) => Date.parse(a.stage_changed_at) - Date.parse(b.stage_changed_at);
  for (const record of records.sort(byAge)) {
    process.stdout.write(`${record.id}  ${record.stage}${record.reason ? `  ${firstLine(record.reason)}` : ""}\n`);
  }
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

// git fetch origin и чтение задач из TARGET. null — сбой, причина напечатана, код 1.
function loadOriginTasks() {
  const fetched = tryGit(["fetch", "origin", "--quiet"]);
  if (!fetched.ok) {
    process.stdout.write(`git fetch origin не удался: ${oneLine(fetched.stderr)}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!tryGit(["rev-parse", "--verify", "--quiet", TARGET]).ok) {
    process.stdout.write(`Нет ссылки ${TARGET}\n`);
    process.exitCode = 1;
    return null;
  }

  const tasks = readOriginTasks(TASK_DIR);
  const statuses = new Map([...ARCHIVE_DIRS.flatMap(readOriginTasks), ...tasks].map((task) => [task.id, task.status]));
  return { tasks, statuses, context: readContext() };
}

// Кандидаты (Ready без причин отказа) и ждущие зависимость, по возрастанию номера.
function pickCandidates({ tasks, statuses, context }) {
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
  return { candidates, waiting };
}

// pnpm factory list: строки SH-NNN<TAB>приоритет<TAB>название, без вопросов и побочных действий.
function printCandidateRows() {
  const loaded = loadOriginTasks();
  if (!loaded) return;
  const found = pickCandidates(loaded);
  const row = (task) => `${task.id}\t${task.priority || "не указан"}\t${task.title}\n`;
  if (found.candidates.length === 0) process.stdout.write("Задач в Ready нет\n");
  for (const task of found.candidates) process.stdout.write(row(task));
  if (found.waiting.length > 0) {
    process.stdout.write("Ждут зависимость:\n");
    for (const task of found.waiting) process.stdout.write(row(task));
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

// `answer` и `continue`: возобновляют воркера задачи.
async function resumeCommand(kind, id, text, primaryFolder, foreground) {
  const record = readState().tasks[id];
  if (!record) {
    process.stdout.write(`${id}: нет записи фабрики\n`);
    process.exitCode = 1;
    return;
  }
  const { from } = MODES[kind];
  if (record.stage !== from) {
    process.stdout.write(`${id}: ${kind} не выполнена, задача на этапе «${record.stage}», нужен «${from}»\n`);
    process.exitCode = 1;
    return;
  }
  if (!checkLimit()) return;
  if (kind === "answer") logLine(id, `ответ владельца: ${text}`);
  return launchWorker(record, primaryFolder, foreground, kind === "answer" ? { kind, text } : { kind });
}

// `drop`: снимает задачу с фабрики.
async function dropCommand(id) {
  const record = readState().tasks[id];
  if (!record) {
    process.stdout.write(`${id}: нет записи фабрики\n`);
    process.exitCode = 1;
    return;
  }
  if (isAlive(record)) {
    process.stdout.write(`${id}: не снята, у записи живой процесс ${record.pid}\n`);
    process.exitCode = 1;
    return;
  }
  const answer = await ask(
    `Снять ${id} с фабрики? Запись удалится. Чистый worktree и ветка без копии на origin тоже. [y/n] `,
  );
  if (!/^(y|yes)$/i.test(answer)) {
    process.stdout.write("Ничего не изменено\n");
    return;
  }
  removeTask(id);
  logLine(id, "снята с фабрики командой drop");
  process.stdout.write(`${id}: запись снята\n`);

  const { worktree, branch } = record;
  if (worktree && existsSync(worktree)) {
    const status = tryGit(["-C", worktree, "status", "--porcelain"]);
    if (!status.ok || String(status.stdout).trim() !== "") {
      process.stdout.write(`Worktree ${worktree} не тронут: есть незакоммиченные изменения\n`);
    } else {
      const removed = tryGit(["worktree", "remove", worktree]);
      if (removed.ok) logLine(id, `git worktree remove ${worktree}`);
      else process.stdout.write(`Worktree ${worktree} не удалён: ${oneLine(removed.stderr)}\n`);
    }
  }
  const worktreeGone = !worktree || !existsSync(worktree);

  if (!branch || !tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return;
  const fetched = tryGit(["fetch", "origin", "--quiet"]);
  if (!fetched.ok) {
    process.stdout.write(`Ветка ${branch} не тронута: git fetch origin не удался: ${oneLine(fetched.stderr)}\n`);
    return;
  }
  if (tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok) {
    process.stdout.write(`Ветка ${branch} не тронута: она есть на origin\n`);
    return;
  }
  if (!worktreeGone) {
    process.stdout.write(`Ветка ${branch} не тронута: worktree ${worktree} остался\n`);
    return;
  }
  const sha = String(tryGit(["rev-parse", `refs/heads/${branch}`]).stdout).trim();
  const deleted = tryGit(["branch", "-D", "--quiet", branch]);
  if (!deleted.ok) {
    process.stdout.write(`Ветка ${branch} не удалена: ${oneLine(deleted.stderr)}\n`);
    return;
  }
  logLine(id, `git branch -D ${branch} (SHA ${sha})`);
  process.stdout.write(`Ветка ${branch} удалена, SHA ${sha}\n`);
}

const SUMMARY_MAX_LINES = 30;
const DENIAL_MAX = 40;
const DENIALS_SHOWN = 3;

// Текст последнего по номеру ответа воркера в папке задачи (`NNN-worker.json`, поле result) или пустая строка.
function lastWorkerResult(id) {
  const dir = join(stateDir(), id);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  const numbered = names
    .map((name) => /^(\d+)-worker\.json$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (numbered.length === 0) return "";
  try {
    const result = JSON.parse(readFileSync(join(dir, numbered[0][0]), "utf8")).result;
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

const QUESTION = "Вопрос владельцу:";

// Строки вопроса из ответа воркера.
function questionLines(result) {
  const lines = result.split("\n").map((line) => line.trim());
  const remarks = firstLine(result).startsWith("ЗАМЕЧАНИЯ");
  const variant = remarks ? /^\d+\. / : /^- [А-ЯЁA-Z](?!\p{L})/u;
  return lines.filter((line) => line.startsWith(QUESTION) || variant.test(line));
}

const clip = (text) => Array.from(text).slice(0, DENIAL_MAX).join("");

// Отказ прав воркера одной строкой.
function denialText(denial) {
  const tool = String(denial?.tool_name ?? denial?.tool ?? "");
  const input = denial?.tool_input ?? {};
  const text = tool === "Bash" ? String(input.command ?? "") : `${tool} ${input.file_path ?? input.path ?? ""}`.trim();
  return clip(text.replace(/\s*\n\s*/g, " "));
}

function ageText(record) {
  const since = Date.parse(record.stage_changed_at);
  if (Number.isNaN(since)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч`;
}

// Строки одной задачи в сводке.
function summaryBlock(record) {
  const lines = [`${record.id}  ${record.stage}  ${ageText(record)}  $${Number(record.cost_usd || 0).toFixed(2)}`];
  if (record.stage === "стоп") {
    for (const line of questionLines(lastWorkerResult(record.id))) lines.push(`  ${line}`);
  } else if (STAGES_WAIT_OWNER.includes(record.stage)) {
    if (record.reason) lines.push(`  ${String(record.reason).replace(/\s*\n\s*/g, " ")}`);
    if (record.stage === "ошибка") lines.push(`  Журнал: ${join(stateDir(), record.id, "log.txt")}`);
  }
  const denials = Array.isArray(record.denials) ? record.denials : [];
  if (denials.length > 0) {
    const shown = denials.slice(0, DENIALS_SHOWN).map(denialText).join("; ");
    lines.push(`  Отказы: ${shown}${denials.length > DENIALS_SHOWN ? " …" : ""}`);
  }
  return lines;
}

// Сводка: сначала задачи, которые ждут владельца, затем остальные.
function printSummary() {
  const records = Object.values(readState().tasks);
  if (records.length === 0) {
    process.stdout.write("Фабрика пуста\n");
    return;
  }
  const byAge = (a, b) => Date.parse(a.stage_changed_at) - Date.parse(b.stage_changed_at);
  const waiting = records.filter((record) => STAGES_WAIT_OWNER.includes(record.stage)).sort(byAge);
  const others = records.filter((record) => !STAGES_WAIT_OWNER.includes(record.stage)).sort(byAge);
  const blocks = [...waiting, ...others].map(summaryBlock);
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = [];
  if (total + 1 <= SUMMARY_MAX_LINES) {
    for (const block of blocks) out.push(...block);
  } else {
    const budget = SUMMARY_MAX_LINES - 2;
    let shown = 0;
    for (const block of blocks) {
      if (out.length + block.length > budget) break;
      out.push(...block);
      shown += 1;
    }
    out.push(`…ещё ${blocks.length - shown} задач`);
  }
  out.push(`Ждут тебя: ${waiting.length}`);
  process.stdout.write(`${out.join("\n")}\n`);
}

const USAGE =
  'Использование: pnpm factory run [SH-NNN] [--foreground] | list | answer SH-NNN "текст" | continue SH-NNN | drop SH-NNN | ready SH-NNN | next SH-NNN | merge SH-NNN | status; без аргументов: сводка\n';

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const foreground = args.includes("--foreground");
  const [command, ...rest] = args.filter((arg) => arg !== "--foreground");
  const idMatch = rest.length > 0 ? /^SH-(\d+)$/i.exec(rest[0]) : null;
  const target = idMatch ? `SH-${idMatch[1]}` : "";
  const valid = {
    undefined: rest.length === 0,
    run: rest.length === 0 || (rest.length === 1 && Boolean(idMatch)),
    answer: rest.length === 2 && Boolean(idMatch) && rest[1].trim() !== "",
    list: rest.length === 0 && !foreground,
    continue: rest.length === 1 && Boolean(idMatch),
    drop: rest.length === 1 && Boolean(idMatch),
    ready: rest.length === 1 && Boolean(idMatch),
    next: rest.length === 1 && Boolean(idMatch),
    merge: rest.length === 1 && Boolean(idMatch),
    status: rest.length === 0,
    _worker: rest.length === 1 && Boolean(idMatch),
    _answer: rest.length === 2 && Boolean(idMatch),
    _continue: rest.length === 1 && Boolean(idMatch),
  };
  const known =
    command === undefined
      ? valid.undefined
      : typeof command === "string" && command !== "undefined" && Object.hasOwn(valid, command) && valid[command];
  if (!known) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (!tryGit(["rev-parse", "--show-toplevel"]).ok) {
    process.stderr.write("Это не git-репозиторий\n");
    process.exitCode = 2;
    return;
  }
  // Основная папка: первая запись списка worktree.
  const primaryFolder = listWorktrees()[0].path;
  process.chdir(primaryFolder);

  if (command === "_worker") return void runWorker(target, primaryFolder, { kind: "start" });
  if (command === "_answer") return void runWorker(target, primaryFolder, { kind: "answer", text: rest[1] });
  if (command === "_continue") return void runWorker(target, primaryFolder, { kind: "continue" });

  if (command === "list") return printCandidateRows();

  markDeadWorkers();
  if (command === undefined) return printSummary();
  if (command === "status") return statusCommand();
  if (command === "drop") return dropCommand(target);
  if (command === "answer") return resumeCommand("answer", target, rest[1], primaryFolder, foreground);
  if (command === "continue") return resumeCommand("continue", target, "", primaryFolder, foreground);

  const findTask = () => {
    const loaded = loadOriginTasks();
    if (!loaded) return undefined;
    const task = loaded.tasks.find((item) => item.id === target);
    if (!task) {
      process.stdout.write(`${target} не найдена: нет в ${TARGET}\n`);
      process.exitCode = 1;
      return undefined;
    }
    const { reasons } = blockers(task, loaded.statuses, loaded.context);
    if (reasons.length > 0) {
      process.stdout.write(`${target} не подготовлена: ${reasons.join("; ")}\n`);
      process.exitCode = 1;
      return undefined;
    }
    return task;
  };

  if (command === "ready") {
    const task = findTask();
    if (task) return readyCommand(task, primaryFolder);
    return;
  }
  if (command === "next") return nextCommand(target, primaryFolder);
  if (command === "merge") return mergeCommand(target, primaryFolder);

  // Запасной run.
  if (!checkLimit()) return;
  const prepared = idMatch ? readState().tasks[`SH-${idMatch[1]}`] : undefined;
  if (prepared?.stage === "подготовлена") return launchWorker(prepared, primaryFolder, foreground);

  const loaded = loadOriginTasks();
  if (!loaded) return;
  const { tasks, statuses, context } = loaded;

  if (idMatch) {
    const task = tasks.find((item) => item.id === target);
    if (!task) {
      process.stdout.write(`${target} не запущена: нет в ${TARGET}\n`);
      process.exitCode = 1;
      return;
    }
    const { reasons } = blockers(task, statuses, context);
    if (reasons.length > 0) {
      process.stdout.write(`${target} не запущена: ${reasons.join("; ")}\n`);
      process.exitCode = 1;
      return;
    }
    return launch(prepare(task, primaryFolder), primaryFolder, foreground);
  }

  const { candidates, waiting } = pickCandidates({ tasks, statuses, context });
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
  return launch(prepare(chosen, primaryFolder), primaryFolder, foreground);
}

const launch = (record, primaryFolder, foreground) =>
  record ? launchWorker(record, primaryFolder, foreground) : undefined;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
