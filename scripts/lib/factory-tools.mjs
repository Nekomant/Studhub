// Права воркера, который фабрика запускает через `claude -p` (docs/process.md §7.1, ADR 0010).
// Правило записано в формате Claude Code: имя инструмента (`Grep`), правило пути (`Edit(//abs/**)`)
// или `Bash(<префикс команды>:*)`. Фабрика передаёт списки аргументами --allowedTools и --disallowedTools;
// режим dontAsk отказывает во всём, чего нет в разрешённых правилах. Запрет сильнее разрешения.

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

// Подкоманды git, которые советует .claude/agents/sh-worker.md. Push намеренно не входит: пушит сессия задачи.
const GIT = ["add", "commit", "status", "log", "diff", "show", "switch", "branch", "rev-parse", "fetch", "merge-base"];

// Скрипты pnpm из package.json, которые нужны воркеру. `pnpm exec` и `pnpm dlx` общим правилом не разрешены:
// через них запускается любая программа, в том числе git push и curl.
const PNPM = [
  "verify",
  "check",
  "test",
  "test:api",
  "test:e2e",
  "format",
  "ac:check",
  "db:up",
  "db:check",
  "db:reset-test",
  "gen:openapi",
  "gen:client",
  "install --frozen-lockfile",
  "exec vitest",
  "exec biome",
  "exec tsc",
];

// Префиксы команд Bash: скрипты проекта, чтение файлов и каталогов, Backlog.md, Docker Compose, git.
// `cat` не входит: файлы читает инструмент Read, а он ограничен worktree и не читает `.env`.
// `head` и `tail` нужны после `|` (например, `pnpm verify | tail -n 40`). Поиск делает инструмент Grep: `grep -r` обходит
// каталог и читает `.env` мимо запретов Read, а запретить его по шаблону нельзя (флаги стоят где угодно).
const BASH = [
  ...PNPM.map((script) => `pnpm ${script}`),
  "node scripts/task.mjs",
  "node scripts/doc.mjs",
  "node scripts/check-ac-coverage.mjs",
  "node scripts/verify.mjs",
  "backlog task",
  "ls",
  "head",
  "tail",
  "wc",
  "mkdir",
  "docker compose",
  ...GIT.map((sub) => `git ${sub}`),
];

// Правила команд Bash. Правила файловых инструментов зависят от worktree: см. workerAllowed.
export const WORKER_ALLOWED = [...BASH.map((prefix) => `Bash(${prefix}:*)`)];

// Файлы окружения и секретов: воркер их не читает и не пишет (CLAUDE.md: `.env` агент не читает).
// `.env.example` не входит: в нём нет секретов, воркер может его читать и править.
const SECRET_PATHS = [
  "**/.env",
  "**/.env.local",
  "**/.env.*.local",
  "**/.env.production",
  "**/.env.development",
  "**/.env.test",
  "**/*.pem",
  "**/id_rsa*",
];

// Запрещено всегда: публикация, сеть, чужие программы через pnpm, секреты. Запрет сильнее разрешения.
// Правила `Bash(* .env*)` ловят `tail .env`, `grep x .env.local`, `head -n 5 ./.env`: у них шаблон со звёздочкой.
export const WORKER_DISALLOWED = [
  ...[
    "git push",
    "gh",
    "curl",
    "rm -rf",
    "pnpm dlx",
    "pnpm exec git",
    "pnpm exec gh",
    "pnpm exec curl",
    "grep",
    "egrep",
    "fgrep",
    "rg",
  ].map((prefix) => `Bash(${prefix}:*)`),
  "Bash(* .env*)",
  "Bash(* */.env*)",
  ...SECRET_PATHS.flatMap((path) => [`Read(${path})`, `Edit(${path})`]),
];

// Лимит стоимости одного запуска воркера, USD (--max-budget-usd). Значение предварительное: у него нет данных
// о стоимости реальных задач; поправить после AC-17. Переопределяет переменная окружения FACTORY_WORKER_BUDGET_USD.
export const WORKER_BUDGET_USD = 10;

// Лимит времени одного запуска воркера, минуты. Значение предварительное. Переопределяет FACTORY_WORKER_TIMEOUT_MIN.
export const WORKER_TIMEOUT_MIN = 180;

function positiveNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name}: ожидается положительное число, получено «${raw}»`);
  return value;
}

export const workerBudgetUsd = (env = process.env) =>
  positiveNumber(env, "FACTORY_WORKER_BUDGET_USD", WORKER_BUDGET_USD);

export const workerTimeoutMs = (env = process.env) =>
  Math.round(positiveNumber(env, "FACTORY_WORKER_TIMEOUT_MIN", WORKER_TIMEOUT_MIN) * 60_000);

// Шаблон пути для правил Read и Edit: `//` и абсолютный путь worktree. Запятая в пути сломала бы список через запятую.
export function worktreeGlob(worktree) {
  const absolute = resolve(existsSync(worktree) ? realpathSync(worktree) : worktree);
  if (absolute.includes(",")) throw new Error(`в пути worktree запятая, правила воркера не построить: ${absolute}`);
  return `/${absolute}/**`;
}

// Разрешённые правила воркера для worktree: чтение, поиск и запись файлов только внутри него.
// Проверено живым запуском claude 2.1.325: `Read`, `Edit`, `Write`, `Grep` и `Glob` с таким шаблоном пускают
// внутрь worktree и отказывают снаружи. Без шаблона `Grep` и `Glob` ищут по любому пути.
export function workerAllowed(worktree) {
  const glob = worktreeGlob(worktree);
  return ["Read", "Edit", "Write", "Grep", "Glob"].map((tool) => `${tool}(${glob})`).concat(WORKER_ALLOWED);
}

// Правило-имя инструмента (`Grep`) подходит, если `command` равна имени. Правило `Bash(<префикс>:*)` подходит,
// если команда начинается с префикса, а дальше идёт конец строки или пробел: `Bash(ls:*)` — к `ls -la`, не к `lsof`.
// Правило `Bash(<шаблон>)` со звёздочкой подходит, если вся команда подходит к шаблону (`*` — любая строка).
export function matchesRule(rule, command) {
  const prefixRule = /^Bash\((.*):\*\)$/.exec(rule);
  if (prefixRule) return command === prefixRule[1] || command.startsWith(`${prefixRule[1]} `);
  const wildcard = /^Bash\((.*\*.*)\)$/.exec(rule);
  if (!wildcard) return rule === command;
  const source = wildcard[1].split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${source.join(".*")}$`).test(command);
}
