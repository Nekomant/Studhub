#!/usr/bin/env node
// Печатает неисправленные замечания из docs/tech-debt.md: `pnpm remarks`.
// Запись — блок с заголовком `## SH-NNN — <название>` и полями `- **поле:** значение`.
// Статус «исправлено…» и «отклонено…» считается разобранным; `--all` печатает и их.
// Скрипт только читает docs/tech-debt.md.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RESOLVED = /исправлено|отклонено|решено|разобрано/i;

// Разбирает markdown файла tech-debt.md в список записей { source, title, fields }.
export function parseDebt(markdown) {
  const records = [];
  let current = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      // Служебный раздел «Формат записи» не является записью.
      if (/Формат записи/i.test(heading[1])) {
        current = null;
        continue;
      }
      current = { title: heading[1].trim(), fields: {} };
      records.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^- \*\*(.+?)\*\*:\s*(.*)$/);
    if (field) current.fields[field[1].trim()] = field[2].trim();
  }
  return records;
}

function main() {
  const showAll = process.argv.includes("--all");
  const markdown = readFileSync("docs/tech-debt.md", "utf8");
  const records = parseDebt(markdown);
  const open = [];
  for (const record of records) {
    const status = record.fields["статус"] ?? "";
    if (!showAll && RESOLVED.test(status)) continue;
    open.push(record);
  }
  if (open.length === 0) {
    console.log("Замечаний нет.");
  } else {
    for (const record of open) {
      const what = record.fields["что не так и где"] ?? record.fields["что не так"] ?? "";
      const status = record.fields["статус"] ?? "";
      console.log(record.title);
      if (what) console.log(`  что не так: ${what}`);
      if (status) console.log(`  статус: ${status}`);
    }
  }
  console.log(`Неисправленных: ${open.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
