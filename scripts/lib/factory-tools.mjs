// Права воркера, который фабрика запускает через `claude -p` (docs/process.md §7.1, ADR 0010).
// Правило записано в формате Claude Code: имя инструмента (`Read`) или `Bash(<префикс команды>:*)`.
// Фабрика передаёт списки аргументами --allowedTools и --disallowedTools; режим dontAsk отказывает во всём,
// чего нет в разрешённых правилах.

// Подкоманды git, которые советует .claude/agents/sh-worker.md. Push намеренно не входит: пушит сессия задачи.
const GIT = ["add", "commit", "status", "log", "diff", "show", "switch", "branch", "rev-parse", "fetch", "merge-base"];

// Префиксы команд Bash: скрипты проекта, чтение файлов и каталогов, Backlog.md, Docker Compose, git.
const BASH = [
  "pnpm",
  "node scripts/task.mjs",
  "node scripts/doc.mjs",
  "node scripts/check-ac-coverage.mjs",
  "node scripts/verify.mjs",
  "backlog task",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "mkdir",
  "docker compose",
  ...GIT.map((sub) => `git ${sub}`),
];

export const WORKER_ALLOWED = ["Read", "Edit", "Write", "Grep", "Glob", ...BASH.map((prefix) => `Bash(${prefix}:*)`)];

// Запрещено всегда: публикация и сеть. Запрет сильнее разрешения.
export const WORKER_DISALLOWED = ["git push", "gh", "curl", "rm -rf"].map((prefix) => `Bash(${prefix}:*)`);

// Лимит стоимости одного запуска воркера, USD (--max-budget-usd).
export const WORKER_BUDGET_USD = 10;

// Правило-имя инструмента (`Read`) подходит, если `command` равна имени. Правило `Bash(<префикс>:*)` подходит,
// если команда начинается с префикса, а дальше идёт конец строки или пробел: `Bash(ls:*)` — к `ls -la`, не к `lsof`.
export function matchesRule(rule, command) {
  const bash = /^Bash\((.*):\*\)$/.exec(rule);
  if (!bash) return rule === command;
  const prefix = bash[1];
  return command === prefix || command.startsWith(`${prefix} `);
}
