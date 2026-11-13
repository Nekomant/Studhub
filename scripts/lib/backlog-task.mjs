// Общий разбор файлов задач Backlog.md для `check-ac-coverage.mjs` и `check-spec.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const DESCRIPTION_END = "<!-- SECTION:DESCRIPTION:END -->";

// Текст между двумя маркерами. Пустая строка, если одного из маркеров нет.
export function section(text, begin, end) {
  const from = text.indexOf(begin);
  const to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
  return from === -1 || to === -1 ? "" : text.slice(from + begin.length, to);
}

// Критерии ищем после описания: в тексте описания маркеры могут встретиться как пример.
export function parseCriteria(text) {
  const afterDescription = text.indexOf(DESCRIPTION_END);
  return section(afterDescription === -1 ? text : text.slice(afterDescription), "<!-- AC:BEGIN -->", "<!-- AC:END -->")
    .split("\n")
    .map((line) => /^- \[[ xX]\] #(\d+)\s+(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ index: Number(match[1]), text: match[2] }));
}

// Номера критериев из ячейки AC: «3», «1–5», «4-5», «1, 2».
export function parseAcCell(cell) {
  const numbers = [];
  for (const part of cell.split(",")) {
    const range = /^\s*(\d+)\s*(?:[–—-]\s*(\d+))?\s*$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    for (let n = from; n <= to; n += 1) numbers.push(n);
  }
  return numbers;
}

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

// Таблица «План тестов» из описания задачи: номер критерия → список уровней. null, если таблицы нет.
export function parseTestPlan(description) {
  const lines = description.split("\n");
  const heading = lines.findIndex((line) => /^#+\s*План тестов\s*$/.test(line.trim()));
  if (heading === -1) return null;
  let i = heading + 1;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  const rows = [];
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    rows.push(cells(lines[i]));
    i += 1;
  }
  if (rows.length < 2) return null;
  const header = rows[0].map((cell) => cell.toLowerCase());
  const acColumn = header.indexOf("ac");
  const levelColumn = header.indexOf("уровень");
  if (acColumn === -1 || levelColumn === -1) return null;

  const plan = new Map();
  for (const row of rows.slice(1)) {
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const level = row[levelColumn] ?? "";
    for (const n of parseAcCell(row[acColumn] ?? "")) plan.set(n, [...(plan.get(n) ?? []), level]);
  }
  return plan;
}

// Разделы описания по заголовкам «## Имя»: имя → текст до следующего заголовка «## ».
// Подзаголовки «###» и строки внутри блоков кода (``` или ~~~) раздел не обрывают.
// Повторный заголовок с тем же именем дописывает текст к разделу.
export function parseSections(description) {
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of description.split("\n")) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (mark) fence = fence === null ? mark : fence === mark ? null : fence;
    const heading = fence === null && !mark ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

// Уровни плана тестов (docs/process.md §8.1). Уровни без теста не требуют метки `[SH-NNN AC-n]` (§8.2).
export const LEVELS = ["Юнит", "API", "E2E", "Ручная", "Ревью", "Скрипт"];
const LEVELS_WITHOUT_LABEL = ["Ручная", "Ревью", "Скрипт"];

// Уровень из списка LEVELS или null. «Ручная», «Ревью» и «Скрипт» принимаются по префиксу
// («Ручная проверка»), остальные уровни по полному совпадению без учёта регистра.
export function normalizeLevel(level) {
  const text = String(level).trim().toLowerCase();
  const exact = LEVELS.find((name) => name.toLowerCase() === text);
  if (exact) return exact;
  return LEVELS_WITHOUT_LABEL.find((name) => text.startsWith(name.toLowerCase())) ?? null;
}

// Нужна ли в тестах метка для критерия этого уровня. Неизвестный уровень метку требует.
export function levelNeedsLabel(level) {
  return !LEVELS_WITHOUT_LABEL.includes(normalizeLevel(level));
}

const toArray = (value) => {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => String(item).trim().toUpperCase()).filter(Boolean);
};

export function parseTask(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const meta = (front ? YAML.parse(front[1]) : null) ?? {};
  const description = section(text, "<!-- SECTION:DESCRIPTION:BEGIN -->", DESCRIPTION_END);
  return {
    id: String(meta.id ?? "").toUpperCase(),
    title: String(meta.title ?? ""),
    priority: String(meta.priority ?? ""),
    status: String(meta.status ?? ""),
    milestone: meta.milestone ? String(meta.milestone) : "",
    dependencies: toArray(meta.dependencies),
    description,
    criteria: parseCriteria(text),
    plan: parseTestPlan(description),
  };
}

// Все задачи из `<root>/backlog/tasks`. Поле `file` — путь относительно корня.
export function readTasks(root) {
  const dir = join(root, "backlog/tasks");
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  return names.sort().map((name) => ({
    ...parseTask(readFileSync(join(dir, name), "utf8")),
    file: `backlog/tasks/${name}`,
  }));
}
