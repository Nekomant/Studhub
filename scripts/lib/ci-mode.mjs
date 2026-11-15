#!/usr/bin/env node
// Классификатор режима CI по списку изменённых файлов (docs/process.md §12, задача SH-107).
// Лёгкий файл — путь начинается с `docs/` (но не `docs/process.md`) либо с `backlog/`.
// Все файлы лёгкие → "light", любой другой файл → "full".
// Как CLI: `git diff --name-only … | node scripts/lib/ci-mode.mjs` печатает режим.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Файл лёгкого режима: docs/ (кроме docs/process.md) или backlog/.
function isLight(file) {
  const path = file.replace(/^\.\//, "");
  if (path === "docs/process.md") return false;
  return path.startsWith("docs/") || path.startsWith("backlog/");
}

// Все файлы лёгкие → "light", иначе "full" (пустой список — "light").
export function classifyFiles(files) {
  return files.every(isLight) ? "light" : "full";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const files = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  process.stdout.write(`${classifyFiles(files)}\n`);
}
