#!/usr/bin/env node
// Печатает неразобранные попутные замечания воркеров: `pnpm remarks`.
// Замечание лежит в заметках задачи строкой `Замечание N: <что и где, чем грозит>`.
// Разбор записывает строку `Замечание N разобрано: <SH-NNN или «отклонено: причина»>`.
// Флаг `--all` печатает и разобранные. Скрипт только читает файлы задач в текущей папке.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OPEN = /^Замечание (\d+): (.+)$/;
const CLOSED = /^Замечание (\d+) разобрано: (.+)$/;

export function parseRemarks(markdown) {
  const id = markdown.match(/^id: (\S+)/m)?.[1];
  const title = markdown.match(/^title: '?(.*?)'?$/m)?.[1] ?? "";
  const notes = markdown.match(/<!-- SECTION:NOTES:BEGIN -->([\s\S]*?)<!-- SECTION:NOTES:END -->/)?.[1] ?? "";
  const remarks = new Map();
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    const open = line.match(OPEN);
    if (open) remarks.set(open[1], { n: open[1], text: open[2], resolution: null });
    const closed = line.match(CLOSED);
    if (closed && remarks.has(closed[1])) remarks.get(closed[1]).resolution = closed[2];
  }
  return { id, title, remarks: [...remarks.values()] };
}

function main() {
  const showAll = process.argv.includes("--all");
  const dir = "backlog/tasks";
  const lines = [];
  let open = 0;
  for (const file of readdirSync(dir).sort()) {
    const { id, remarks } = parseRemarks(readFileSync(join(dir, file), "utf8"));
    for (const r of remarks) {
      if (r.resolution && !showAll) continue;
      if (!r.resolution) open += 1;
      lines.push(`${id} №${r.n}: ${r.text}${r.resolution ? `  [разобрано: ${r.resolution}]` : ""}`);
    }
  }
  console.log(lines.length ? lines.join("\n") : "Замечаний нет.");
  console.log(`Неразобранных: ${open}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
