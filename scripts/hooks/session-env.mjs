#!/usr/bin/env node
// Хук SessionStart из .claude/settings.json. Новый worktree — это чистая копия без `.env`,
// поэтому хук берёт `.env` основной папки клона и пишет переменные из списка ALLOWED как `export` в $CLAUDE_ENV_FILE.
// Claude Code выполняет этот файл перед каждой командой Bash в сессии, так команды видят, например, POSTGRES_PORT.
// Остальные переменные `.env` (ключи, секреты, NODE_ENV) хук пропускает. Значения он не печатает.
// Если в самом worktree есть свой `.env`, его значения важнее. Без `.env` или при любой ошибке хук молча
// завершается с кодом 0: старт сессии он не роняет.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Единственный список переменных, которые хук передаёт в сессию. Новую переменную добавляем сюда
// и в docs/process.md §7.1.
const ALLOWED = ["POSTGRES_PORT", "DATABASE_URL", "TEST_DATABASE_URL"];

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

// Простой разбор `.env`: KEY=VALUE, комментарии и пустые строки пропускаются.
// Значение в кавычках берётся до закрывающей кавычки, комментарий после неё отбрасывается.
function parse(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (!ALLOWED.includes(match[1])) continue;
    const quoted = /^(["'])(.*?)\1(\s+#.*)?$/.exec(match[2]);
    vars[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, "");
  }
  return vars;
}

try {
  const vars = { ...parse(join(mainRoot, ".env")), ...parse(join(worktreeRoot, ".env")) };
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}\n`);
  if (lines.length > 0) appendFileSync(envFile, lines.join(""));
} catch {
  // Нечитаемый `.env` или файл окружения: сессия стартует без переменных.
}
