// Общий разбор файлов задач Backlog.md для `check-ac-coverage.mjs` и `check-spec.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

// Текст между двумя маркерами. Пустая строка, если одного из маркеров нет.
export function section(text, begin, end) {
  const from = text.indexOf(begin);
  const to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
  return from === -1 || to === -1 ? "" : text.slice(from + begin.length, to);
}

export function parseCriteria(text) {
  return section(text, "<!-- AC:BEGIN -->", "<!-- AC:END -->")
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

// Разделы описания по заголовкам «## Имя»: имя → текст до следующего заголовка.
export function parseSections(description) {
  const sections = new Map();
  let current = null;
  for (const line of description.split("\n")) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

export function parseTask(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const meta = front ? YAML.parse(front[1]) : {};
  const description = section(text, "<!-- SECTION:DESCRIPTION:BEGIN -->", "<!-- SECTION:DESCRIPTION:END -->");
  return {
    id: String(meta.id ?? "").toUpperCase(),
    status: String(meta.status ?? ""),
    milestone: meta.milestone ? String(meta.milestone) : "",
    dependencies: (meta.dependencies ?? []).map((id) => String(id).toUpperCase()),
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
