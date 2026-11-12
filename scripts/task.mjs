#!/usr/bin/env node
// Печатает задачу Backlog.md коротко: `node scripts/task.mjs SH-NNN`.
// Флаг `--criteria` печатает только критерии приёмки и таблицу «План тестов» (так задачу читает sh-verifier).
// Берёт `backlog task view --json` и выводит описание, критерии, DoD, план, заметки, комментарии и итог.
// Дерево зависимых задач (dependencyGraph) не печатает: в `--plain` оно занимает до половины вывода.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const checklist = (items) =>
  items.length === 0
    ? ""
    : items.map((item) => `- [${item.checked ? "x" : " "}] #${item.index} ${item.text}`).join("\n");

const listOrDash = (items) => (items?.length ? items.join(", ") : "—");

function commentsText(comments) {
  return comments
    .map((comment) => {
      const who = [comment.author, comment.createdAt ?? comment.date].filter(Boolean).join(", ");
      return `${who ? `${who}: ` : ""}${comment.content ?? comment.text ?? ""}`;
    })
    .join("\n\n");
}

export function formatTask(task) {
  const head = [
    `${task.id} ${task.title}`,
    `Статус: ${task.status} · тип ${task.type ?? "—"} · приоритет ${task.priority ?? "—"} · метки ${listOrDash(task.labels)} · веха ${task.milestone ?? "—"}`,
    `Исполнитель: ${listOrDash(task.assignees)} · зависит от: ${listOrDash(task.dependencies)}`,
  ];
  if (task.references?.length) head.push(`Ссылки: ${task.references.join(", ")}`);
  if (task.documentation?.length) head.push(`Документы: ${task.documentation.join(", ")}`);

  const sections = [
    ["Описание", task.description],
    ["Критерии приёмки", checklist(task.acceptanceCriteria ?? [])],
    ["Definition of Done", checklist(task.definitionOfDone ?? [])],
    ["План", task.implementationPlan],
    ["Заметки", task.implementationNotes],
    ["Комментарии", commentsText(task.comments ?? [])],
    ["Итог", task.finalSummary],
  ];
  const body = sections
    .filter(([, text]) => typeof text === "string" && text.trim() !== "")
    .map(([title, text]) => `# ${title}\n${text.trim()}`);
  return `${[head.join("\n"), ...body].join("\n\n")}\n`;
}

// Таблица «План тестов» из описания: строки от заголовка до первой строки не из таблицы. null, если таблицы нет.
function testPlanTable(description) {
  const lines = (description ?? "").split("\n");
  const heading = lines.findIndex((line) => /^#+\s*План тестов\s*$/.test(line.trim()));
  if (heading === -1) return null;
  let i = heading + 1;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  const rows = [];
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    rows.push(lines[i].trim());
    i += 1;
  }
  return rows.length > 0 ? rows.join("\n") : null;
}

export function formatCriteria(task) {
  const criteria = checklist(task.acceptanceCriteria ?? []) || "Критериев приёмки нет.";
  const table = testPlanTable(task.description) ?? "В описании задачи нет таблицы «План тестов».";
  return `# Критерии приёмки\n${criteria}\n\n# План тестов\n${table}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const criteriaOnly = args.includes("--criteria");
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    process.stderr.write("Использование: node scripts/task.mjs SH-NNN [--criteria]\n");
    process.exit(1);
  }
  const result = spawnSync("backlog", ["task", "view", id, "--json"], { encoding: "utf8" });
  if (result.error) {
    process.stderr.write(`Не удалось запустить backlog: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(
      `backlog task view ${id} завершился с кодом ${result.status}\n${result.stderr}${result.stdout}`,
    );
    process.exit(result.status ?? 1);
  }
  const task = JSON.parse(result.stdout).task;
  process.stdout.write(criteriaOnly ? formatCriteria(task) : formatTask(task));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
