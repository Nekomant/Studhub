#!/usr/bin/env node
// Печатает задачу Backlog.md коротко: `node scripts/task.mjs SH-NNN`.
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

function main() {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write("Использование: node scripts/task.mjs SH-NNN\n");
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
  process.stdout.write(formatTask(JSON.parse(result.stdout).task));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
