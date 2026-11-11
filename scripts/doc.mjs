#!/usr/bin/env node
// Печатает один раздел документа из docs/: `node scripts/doc.mjs <документ> <раздел>`.
// Документ: td (technical-design), uc (use-cases), screens или имя любого файла docs/*.md без .md.
// Раздел: первое слово заголовка, например 4.1, §4.1, UC-01, Э-01, П-3. Раздел идёт до следующего
// заголовка того же или более высокого уровня, поэтому `td 4` печатает §4 вместе с 4.1–4.10.
// Без раздела или с несуществующим разделом скрипт печатает список разделов и завершается с кодом 1.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const docsDir = resolve(import.meta.dirname, "../docs");
const aliases = { td: "technical-design", uc: "use-cases" };

function headings(lines) {
  const found = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{1,6})\s+(\S+)(.*)$/.exec(line);
    if (match) found.push({ index, level: match[1].length, key: normalize(match[2]), title: `${match[2]}${match[3]}` });
  });
  return found;
}

const normalize = (key) => key.replace(/^§/, "").replace(/[.:]$/, "").toLowerCase();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [docArg, sectionArg] = process.argv.slice(2);
const available = readdirSync(docsDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -3));
if (!docArg) {
  fail(`Использование: node scripts/doc.mjs <документ> <раздел>\nДокументы: td, uc, ${available.join(", ")}`);
}
const docName = aliases[docArg] ?? docArg.replace(/\.md$/, "").replace(/^docs\//, "");
const path = join(docsDir, `${docName}.md`);
if (!existsSync(path)) fail(`Документа docs/${docName}.md нет. Документы: td, uc, ${available.join(", ")}`);

const lines = readFileSync(path, "utf8").split("\n");
const all = headings(lines).filter((heading) => heading.level > 1);
const list = () => all.map((heading) => `${"  ".repeat(heading.level - 2)}${heading.title}`).join("\n");

if (!sectionArg) fail(`Разделы docs/${docName}.md:\n${list()}`);
const wanted = normalize(sectionArg);
const start = all.findIndex((heading) => heading.key === wanted);
if (start === -1) fail(`В docs/${docName}.md нет раздела «${sectionArg}». Разделы:\n${list()}`);

const end = all.slice(start + 1).find((heading) => heading.level <= all[start].level);
const text = lines
  .slice(all[start].index, end ? end.index : lines.length)
  .join("\n")
  .trimEnd();
process.stdout.write(`${text}\n`);
