#!/usr/bin/env node
// Хук SessionStart из .claude/settings.json. Новый worktree — это чистая копия без `.env`,
// поэтому хук берёт `.env` основной папки клона и пишет его переменные как `export` в $CLAUDE_ENV_FILE.
// Claude Code выполняет этот файл перед каждой командой Bash в сессии, так команды видят, например, POSTGRES_PORT.
// Если в самом worktree есть свой `.env`, его значения важнее. Значения хук не печатает.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);

let cwd = process.cwd();
try {
  cwd = JSON.parse(readFileSync(0, "utf8") || "{}").cwd ?? cwd;
} catch {
  // Без входа хук работает от текущей папки.
}

const git = (...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const top = git("rev-parse", "--show-toplevel");
const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
if (top.status !== 0 || common.status !== 0) process.exit(0);
const worktreeRoot = top.stdout.trim();
const mainRoot = dirname(common.stdout.trim());

// Простой разбор `.env`: KEY=VALUE, комментарии и пустые строки пропускаются, кавычки вокруг значения снимаются.
function parse(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    vars[match[1]] = value;
  }
  return vars;
}

const vars = { ...parse(join(mainRoot, ".env")), ...parse(join(worktreeRoot, ".env")) };
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const lines = Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}\n`);
if (lines.length > 0) appendFileSync(envFile, lines.join(""));
