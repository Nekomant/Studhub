#!/usr/bin/env node
// Проверка покрытия критериев приёмки тестами (docs/process.md §8.2).
// Для каждой задачи в статусе Review или Done из backlog/tasks ищет в файлах тестов метку
// `[SH-NNN AC-n]` (или `[SH-NNN AC-1, AC-3]`) на каждый критерий.
// Метку не требуют критерии, которые по таблице «План тестов» проверяются на уровне «Ручная», «Ревью»
// или «Скрипт»: если метки у такого критерия нет, скрипт печатает его как пропущенный. Остальные уровни (Юнит, Unit, API, E2E и любые другие)
// требуют метку. Если таблицы нет, метка нужна всем критериям.
// Код выхода 1, если есть непокрытые критерии. Флаг --root задаёт корень репозитория (нужен тестам).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTasks } from "./lib/backlog-task.mjs";

const CHECKED_STATUSES = new Set(["Review", "Done"]);
const LEVELS_WITHOUT_LABEL = ["ручная", "ревью", "скрипт"];
// Папки, где файлы тестов не ищем: зависимости, служебные папки и фикстуры инструментов.
const SKIPPED_DIRS = new Set(["node_modules", "backlog", "dist", "build", "coverage"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const LABEL = /\[(SH-\d+)\s+(AC-\d+(?:\s*,\s*AC-\d+)*)\]/gi;

const needsLabel = (level) => !LEVELS_WITHOUT_LABEL.some((prefix) => level.trim().toLowerCase().startsWith(prefix));

function listTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name) || entry.name.endsWith("fixtures")) continue;
      files.push(...listTestFiles(join(dir, entry.name)));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// Множество «SH-NNN AC-n» по всем меткам в файлах тестов.
function collectLabels(root) {
  const labels = new Set();
  for (const file of listTestFiles(root)) {
    for (const match of readFileSync(file, "utf8").matchAll(LABEL)) {
      const id = match[1].toUpperCase();
      for (const ac of match[2].split(",")) labels.add(`${id} ${ac.trim().toUpperCase()}`);
    }
  }
  return labels;
}

export function checkCoverage(tasks, labels) {
  const uncovered = [];
  const skipped = [];
  for (const task of tasks) {
    if (!CHECKED_STATUSES.has(task.status)) continue;
    const taskSkipped = [];
    for (const criterion of task.criteria) {
      if (labels.has(`${task.id} AC-${criterion.index}`)) continue;
      const levels = task.plan?.get(criterion.index);
      if (levels && !levels.some(needsLabel)) taskSkipped.push(`AC-${criterion.index} (${levels.join(", ")})`);
      else uncovered.push({ id: task.id, ...criterion });
    }
    if (taskSkipped.length > 0) skipped.push(`${task.id}: ${taskSkipped.join(", ")}`);
  }
  return { uncovered, skipped };
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag === -1
      ? resolve(fileURLToPath(new URL("..", import.meta.url)))
      : resolve(process.argv[rootFlag + 1] ?? ".");
  const tasks = readTasks(root);
  const { uncovered, skipped } = checkCoverage(tasks, collectLabels(root));

  if (skipped.length > 0) {
    console.log("Без метки по плану тестов (ручная проверка, ревью или скрипт):");
    for (const line of skipped) console.log(`- ${line}`);
  }
  if (uncovered.length > 0) {
    console.error("Критерии без метки [SH-NNN AC-n] в тестах:");
    for (const item of uncovered) console.error(`- ${item.id} AC-${item.index}: ${item.text}`);
    process.exit(1);
  }
  const checked = tasks.filter((task) => CHECKED_STATUSES.has(task.status)).length;
  console.log(`Критерии покрыты: задач в Review и Done ${checked}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
