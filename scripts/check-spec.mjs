#!/usr/bin/env node
// Проверка спецификации задач по шаблону docs/process.md §4 и Definition of Ready §5.
// Читает backlog/tasks напрямую и проверяет структуру, а не смысл критериев.
//   node scripts/check-spec.mjs SH-NNN [SH-MMM …]  указанные задачи в любом статусе
//   node scripts/check-spec.mjs                    все задачи в статусе Ready
//   node scripts/check-spec.mjs --changed          задачи в Ready, чьи файлы изменены относительно origin/main
//   --root <папка>                                 корень репозитория (нужен тестам)
// Вывод: строка на задачу, под ней строки «ОШИБКА: …» и «ПРЕДУПРЕЖДЕНИЕ: …». Код выхода 1, если есть ошибки.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEVELS, normalizeLevel, parseSections, readTasks } from "./lib/backlog-task.mjs";

const REQUIRED_SECTIONS = ["Что нужно сделать", "Зачем", "Контекст", "Не входит", "Контракт", "План тестов"];
const MAX_CRITERIA = 10;
// Статусы зависимости, при которых задачу в Ready можно брать в работу.
const DEPENDENCY_STATUSES_OK = new Set(["Done", "In Progress", "Review"]);
const OWNER_ACTION =
  /купи|оплат|зарегистрир|созда\S*\s+аккаунт|получ\S*\s+(?:\S+\s+)?(?:ключ|токен|секрет)|подпис|договор/i;
const DEPENDS_ON_TEXT = /(?<!(?:^|[^а-яё])не\s+)зависит\s+от\s+((?:SH-\d+(?:\s*(?:,|и)\s*)?)+)/gi;

const milestoneNumber = (milestone) => {
  const match = /^m-(\d+)$/i.exec(milestone);
  return match ? Number(match[1]) : null;
};

// Пункты нумерованного списка «1. …» с продолжением на следующих строках. Вложенные списки не входят в пункт.
function listItems(text) {
  const items = [];
  for (const line of text.split("\n")) {
    if (/^\d+\.\s/.test(line)) items.push(line.replace(/^\d+\.\s+/, ""));
    else if (items.length > 0 && /^\s+[^\s\-*]/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

const acList = (numbers) => numbers.map((n) => `AC-${n}`).join(", ");

// Возвращает { errors, warnings } для одной задачи. byId — все задачи репозитория по ID.
export function checkTask(task, byId) {
  const errors = [];
  const warnings = [];
  const sections = parseSections(task.description);

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) errors.push(`нет раздела «${name}»`);
    else if (sections.get(name) === "") errors.push(`раздел «${name}» пуст`);
  }

  const criteria = task.criteria.map((criterion) => criterion.index);
  if (criteria.length === 0) errors.push("нет ни одного критерия приёмки");
  else {
    const planned = task.plan ? [...task.plan.keys()] : [];
    const missing = criteria.filter((n) => !planned.includes(n));
    if (missing.length > 0) errors.push(`у критериев ${acList(missing)} нет строки в плане тестов`);
    const extra = planned.filter((n) => !criteria.includes(n));
    if (extra.length > 0) errors.push(`в плане тестов есть номера без критериев: ${acList(extra)}`);
  }

  for (const [n, levels] of task.plan ?? []) {
    for (const level of levels) {
      if (normalizeLevel(level) === null) errors.push(`AC-${n}: уровень «${level}» не из списка ${LEVELS.join(", ")}`);
    }
  }

  const own = milestoneNumber(task.milestone);
  for (const id of task.dependencies) {
    const dependency = byId.get(id);
    if (!dependency) {
      errors.push(`зависимость ${id}: такой задачи нет`);
      continue;
    }
    const theirs = milestoneNumber(dependency.milestone);
    if (own !== null && theirs !== null && theirs > own)
      errors.push(`зависимость ${id} из более поздней вехи ${dependency.milestone} (у задачи ${task.milestone})`);
    if (task.status === "Ready" && !DEPENDENCY_STATUSES_OK.has(dependency.status))
      warnings.push(`зависимость ${id} в статусе ${dependency.status}: нужен Done, In Progress или Review`);
  }

  const mentioned = new Set();
  for (const match of task.description.matchAll(DEPENDS_ON_TEXT)) {
    for (const id of match[1].match(/SH-\d+/gi)) mentioned.add(id.toUpperCase());
  }
  for (const id of mentioned) {
    if (id !== task.id && !task.dependencies.includes(id))
      errors.push(`в тексте «зависит от ${id}», но ${id} нет в зависимостях`);
  }

  for (const item of listItems(sections.get("Что нужно сделать") ?? "")) {
    if (OWNER_ACTION.test(item) && !/^Владелец:/.test(item))
      warnings.push(`шаг с действием владельца не начинается с «Владелец:»: ${item.slice(0, 60)}`);
  }

  if (criteria.length > MAX_CRITERIA)
    warnings.push(`критериев ${criteria.length} (больше ${MAX_CRITERIA}): задача, возможно, не укладывается в 2 дня`);

  return { errors, warnings };
}

// Файлы задач, изменённые относительно origin/main: коммиты ветки после ответвления (merge-base),
// незакоммиченные правки и неотслеженные файлы. null, если origin/main недоступен.
// Если общего предка нет (мелкий клон в CI), сравниваем с вершиной origin/main: в CI HEAD это merge-коммит PR.
function changedFiles(root) {
  const run = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const names = (result) => (result.stdout ?? "").split("\0").filter(Boolean);
  const dir = ["--", "backlog/tasks"];
  if (run(["rev-parse", "--verify", "--quiet", "origin/main"]).status !== 0) return null;
  let committed = run(["diff", "--name-only", "-z", "origin/main...HEAD", ...dir]);
  if (committed.status !== 0) committed = run(["diff", "--name-only", "-z", "origin/main", "HEAD", ...dir]);
  if (committed.status !== 0) return null;
  const uncommitted = run(["diff", "--name-only", "-z", "HEAD", ...dir]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z", ...dir]);
  return new Set([...names(committed), ...names(uncommitted), ...names(untracked)]);
}

function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root =
    rootFlag === -1 ? resolve(fileURLToPath(new URL("..", import.meta.url))) : resolve(args[rootFlag + 1] ?? ".");
  const ids = args
    .filter((arg, i) => !arg.startsWith("--") && (rootFlag === -1 || i !== rootFlag + 1))
    .map((arg) => arg.toUpperCase());

  const tasks = readTasks(root);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let selected;
  let failed = false;

  if (ids.length > 0) {
    selected = [];
    for (const id of ids) {
      const task = byId.get(id);
      if (task) selected.push(task);
      else {
        console.log(`${id}: ошибок 1, предупреждений 0\nОШИБКА: задача не найдена в backlog/tasks`);
        failed = true;
      }
    }
  } else if (args.includes("--changed")) {
    const changed = changedFiles(root);
    if (changed === null) {
      console.error("Не удалось сравнить с origin/main. Получи ветку: git fetch origin main");
      process.exit(1);
    }
    selected = tasks.filter((task) => task.status === "Ready" && changed.has(task.file));
  } else {
    selected = tasks.filter((task) => task.status === "Ready");
  }

  for (const task of selected) {
    const { errors, warnings } = checkTask(task, byId);
    console.log(
      errors.length + warnings.length === 0
        ? `${task.id}: OK`
        : `${task.id}: ошибок ${errors.length}, предупреждений ${warnings.length}`,
    );
    for (const error of errors) console.log(`ОШИБКА: ${error}`);
    for (const warning of warnings) console.log(`ПРЕДУПРЕЖДЕНИЕ: ${warning}`);
    if (errors.length > 0) failed = true;
  }
  if (selected.length === 0 && !failed) console.log("Нет задач для проверки.");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
