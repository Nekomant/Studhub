#!/usr/bin/env node
// Хук PreToolUse агента sh-worker на Edit и Write. Задачи Backlog.md меняются только через CLI `backlog`,
// поэтому правка файла внутри папки backlog/ блокируется кодом 2: Claude Code отменяет вызов
// и показывает агенту текст из stderr. Остальные пути хук пропускает с кодом 0.
// Папку Backlog.md хук узнаёт по файлу config.yml в ней, а не по имени в пути.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function backlogRootOf(path) {
  let dir = dirname(path);
  while (true) {
    if (basename(dir) === "backlog" && existsSync(join(dir, "config.yml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Непонятный вход блокирует вызов: хук должен отказывать, а не пропускать молча.
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.stderr.write("Хук block-backlog-edit не смог разобрать вход Claude Code, вызов заблокирован.\n");
  process.exit(2);
}
const filePath = input.tool_input?.file_path;
if (typeof filePath === "string" && filePath !== "") {
  const base = input.cwd ?? process.cwd();
  const absolute = isAbsolute(filePath) ? filePath : resolve(base, filePath);
  if (backlogRootOf(absolute)) {
    process.stderr.write(
      `Файлы в backlog/ правятся только через CLI backlog (например, \`backlog task edit SH-NNN --append-notes "…"\`), а не через ${input.tool_name ?? "Edit/Write"}.\n`,
    );
    process.exit(2);
  }
}
