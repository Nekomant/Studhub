// Состояние фабрики (ADR 0010): `pnpm factory` и задачи SH-094–SH-098 читают и пишут его только через этот модуль.
// Файлы лежат в `<git common dir>/factory/`, в рабочее дерево и коммиты не попадают:
//   state.json      записи задач: { tasks: { "SH-NNN": {…} } }
//   state.lock/     блокировка записи (каталог, создаётся через mkdir)
//   SH-NNN/log.txt  журнал: смены этапа и запуски команд; рядом лежат JSON-ответы `claude` (001-worker.json, …)
// Запись state.json атомарная: временный файл и rename, под блокировкой. Блокировку старше 30 секунд считаем брошенной.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Все этапы по порядку. Список меняют только задачи SH-094–SH-097 вместе с ADR 0010.
export const STAGES = [
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
];

// Этапы, где работает процесс. «подготовлена» не входит ни в этот список, ни в STAGES_WAIT_OWNER:
// процесса нет, а владельцу делать нечего. SH-095 добавит «готово», SH-097 — «готово к PR».
export const STAGES_RUNNING = ["в работе", "проверки"];

// Этапы, которые ждут владельца. SH-095 и SH-097 уберут из списка «готово» и «готово к PR».
export const STAGES_WAIT_OWNER = [
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
];

export const LOCK_WAIT_MS = 5000;
export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

// Ошибка: блокировку state.lock не удалось взять за LOCK_WAIT_MS.
export class StateBusyError extends Error {
  constructor() {
    super("Состояние занято");
    this.name = "StateBusyError";
  }
}

const now = () => new Date().toISOString();

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const dirCache = new Map();

// Папка состояния: `<git common dir>/factory`. Общая для основной папки и всех worktree клона.
export function stateDir(cwd = process.cwd()) {
  const key = resolve(cwd);
  if (dirCache.has(key)) return dirCache.get(key);
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`не git-репозиторий: ${String(result.stderr).trim()}`);
  const common = result.stdout.trim();
  const dir = join(isAbsolute(common) ? common : resolve(cwd, common), "factory");
  dirCache.set(key, dir);
  return dir;
}

const stateFile = () => join(stateDir(), "state.json");
const lockDir = () => join(stateDir(), "state.lock");

export const emptyState = () => ({ tasks: {} });

// Состояние без блокировки: запись атомарная, читатель видит либо старый файл, либо новый.
export function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
    return { ...emptyState(), ...parsed, tasks: parsed.tasks ?? {} };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

function takeLock() {
  const lock = lockDir();
  mkdirSync(stateDir(), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    removeStaleLock(lock);
    if (Date.now() >= deadline) throw new StateBusyError();
    sleep(LOCK_RETRY_MS);
  }
}

// Брошенную блокировку переименовываем, а не удаляем: из двух процессов переименование удаётся одному,
// второй не снимет чужую свежую блокировку.
function removeStaleLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
    const trash = `${lock}.stale-${process.pid}-${Date.now()}`;
    renameSync(lock, trash);
    rmSync(trash, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function releaseLock() {
  try {
    rmdirSync(lockDir());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Читает состояние под блокировкой, применяет change(state) и записывает результат.
function withState(change) {
  takeLock();
  try {
    const state = readState();
    const result = change(state);
    const file = stateFile();
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, file);
    return result;
  } finally {
    releaseLock();
  }
}

// Журнал задачи: `<stateDir>/SH-NNN/log.txt`, строка `<время> <текст>`.
export function logLine(id, text) {
  const dir = join(stateDir(), id);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "log.txt"), `${now()} ${text}\n`);
}

const stageLine = (from, to, reason) => `этап: ${from} → ${to}; ${reason}`;

const assertStage = (stage) => {
  if (!STAGES.includes(stage)) throw new Error(`неизвестный этап: ${stage}`);
};

// Начальные значения записи задачи. fields перекрывает их.
export function newTask(id, fields = {}) {
  const at = now();
  return {
    id,
    title: "",
    branch: "",
    worktree: "",
    stage: "подготовлена",
    stage_changed_at: at,
    reason: "",
    session_id: "",
    session_ready: false,
    pid: null,
    pid_started_at: "",
    cost_usd: 0,
    rounds: 0,
    rounds_total: 0,
    denials: [],
    verify_summary: "",
    review_count: 0,
    pr_url: "",
    updated_at: at,
    ...fields,
  };
}

// Создаёт запись задачи. Старая запись с тем же ID заменяется. В журнал идёт смена этапа: у новой записи старый этап «—».
export function createTask(id, fields = {}) {
  const task = newTask(id, fields);
  assertStage(task.stage);
  const previous = withState((state) => {
    const old = state.tasks[id]?.stage ?? "—";
    state.tasks[id] = task;
    return old;
  });
  logLine(id, stageLine(previous, task.stage, task.reason));
  return task;
}

// Меняет поля записи. patch — объект или функция (запись) → объект: функция нужна для приращений,
// потому что читается она под блокировкой. Неизвестный ID — ошибка.
export function updateTask(id, patch) {
  return withState((state) => {
    const task = state.tasks[id];
    if (!task) throw new Error(`нет записи фабрики для ${id}`);
    const changes = typeof patch === "function" ? patch(task) : patch;
    state.tasks[id] = { ...task, ...changes, updated_at: now() };
    return state.tasks[id];
  });
}

// Меняет этап и пишет смену в журнал. Неизвестный этап — ошибка.
export function setStage(id, stage, reason = "") {
  assertStage(stage);
  let from = "—";
  const task = updateTask(id, (current) => {
    from = current.stage;
    return { stage, reason, stage_changed_at: now() };
  });
  logLine(id, stageLine(from, stage, reason));
  return task;
}
