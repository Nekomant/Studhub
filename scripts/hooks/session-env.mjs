#!/usr/bin/env node
// Хук SessionStart из .claude/settings.json. Новый worktree — это чистая копия без `.env`,
// поэтому хук берёт `.env` основной папки клона и пишет переменные из списка ALLOWED как `export` в $CLAUDE_ENV_FILE.
// Список ALLOWED и разбор `.env` лежат в модуле local-env рядом с общими скриптами, их использует и фабрика.
// Claude Code выполняет этот файл перед каждой командой Bash в сессии, так команды видят локальные переменные.
// Остальные переменные `.env` (ключи, секреты, NODE_ENV) хук пропускает. Значения он не печатает.
// Если в самом worktree есть свой `.env`, его значения важнее. Без `.env` или при любой ошибке хук молча
// завершается с кодом 0: старт сессии он не роняет.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);

let cwd = process.cwd();
try {
  cwd = JSON.parse(readFileSync(0, "utf8") || "{}").cwd ?? cwd;
} catch {
  // Без входа хук работает от текущей папки.
}

const paths = spawnSync(
  "git",
  ["-C", cwd, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
  { encoding: "utf8" },
);
if (paths.status !== 0) process.exit(0);
const [worktreeRoot, commonDir] = paths.stdout.trim().split("\n");
const mainRoot = dirname(commonDir);

try {
  // Импорт внутри try: ошибка в модуле не должна ломать старт сессии.
  const { readLocalEnv } = await import("../lib/local-env.mjs");
  const vars = { ...readLocalEnv(mainRoot), ...readLocalEnv(worktreeRoot) };
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}\n`);
  if (lines.length > 0) appendFileSync(envFile, lines.join(""));
} catch {
  // Нечитаемый `.env` или файл окружения: сессия стартует без переменных.
}
