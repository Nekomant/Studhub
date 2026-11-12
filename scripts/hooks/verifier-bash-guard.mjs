#!/usr/bin/env node
// Хук PreToolUse агента sh-verifier на Bash. Агент ничего не меняет в рабочем дереве, ветках и истории git,
// поэтому хук пропускает с кодом 0 только команды чтения и запуск тестов. Всё остальное блокируется кодом 2:
// Claude Code отменяет вызов и показывает агенту текст из stderr.
// Это белый список: команда вне списка блокируется, даже если безобидна. Составные команды
// (`&&`, `||`, `;`, `|`, `&`, перевод строки) проверяются по частям. Подстановки `$(…)`, обратные кавычки,
// `<(…)`, heredoc и перенаправление вывода в файл блокируются. Разрешены только `2>&1`, `>&2` и `>/dev/null`.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "echo",
  "printf",
  "pwd",
  "cd",
  "stat",
  "file",
  "find",
  "sed",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "true",
  "false",
  "test",
  "[",
  "date",
  "which",
]);

const GIT_READ = new Set([
  "diff",
  "log",
  "show",
  "status",
  "rev-parse",
  "rev-list",
  "merge-base",
  "ls-files",
  "ls-tree",
  "cat-file",
  "grep",
  "blame",
  "shortlog",
  "name-rev",
  "describe",
  "diff-tree",
  "show-ref",
  "for-each-ref",
]);

const NODE_SCRIPTS = new Set(["scripts/task.mjs", "scripts/doc.mjs", "scripts/check-ac-coverage.mjs"]);
const FIND_WRITE_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
// Безопасные перенаправления: в поток ошибок и в /dev/null.
const SAFE_REDIRECT = /(?:&|\d)?>>?\s*(?:&\d|\/dev\/null)/y;

// Делит команду на сегменты и слова. Возвращает { segments } или { reason }.
export function tokenize(command) {
  const segments = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === "\\") {
      word = (word ?? "") + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "`") return { reason: "обратные кавычки" };
    if (ch === "$" && command[i + 1] === "(") return { reason: "подстановка $(…)" };
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      word = word ?? "";
      continue;
    }
    SAFE_REDIRECT.lastIndex = i;
    const redirect = SAFE_REDIRECT.exec(command);
    if (redirect && (i === 0 || /[\s\d&]/.test(command[i - 1] ?? " ") || redirect[0].startsWith(">"))) {
      endWord();
      i += redirect[0].length - 1;
      continue;
    }
    if (ch === ">") return { reason: "перенаправление вывода в файл" };
    if (ch === "<" && (command[i + 1] === "<" || command[i + 1] === "(")) return { reason: "heredoc или <(…)" };
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return { reason: "группировка команд" };
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      endSegment();
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    word = (word ?? "") + ch;
  }
  if (quote) return { reason: "незакрытая кавычка" };
  endSegment();
  return { segments };
}

const isOption = (word) => word.startsWith("-");
const hasOutputOption = (args) => args.some((arg) => /^--output(?:-|=|$)/.test(arg) || /^--outputFile/.test(arg));

function checkGit(args) {
  const [sub, ...rest] = args;
  if (!sub) return "git без подкоманды";
  if (isOption(sub)) return `git ${sub}: опции до подкоманды не разрешены`;
  if (sub === "branch") {
    const allowed = new Set(["--show-current", "--list", "-a", "-r", "-v", "-vv"]);
    return rest.every((arg) => allowed.has(arg))
      ? null
      : "git branch меняет ветки; разрешены --show-current, --list, -a, -r, -v";
  }
  if (sub === "worktree") return rest[0] === "list" && rest.length === 1 ? null : "git worktree: разрешён только list";
  if (!GIT_READ.has(sub)) return `git ${sub} не входит в команды чтения`;
  if (hasOutputOption(rest)) return `git ${sub} --output пишет в файл`;
  if (sub === "grep" && rest.some((arg) => arg === "-O" || arg.startsWith("-O") || arg === "--open-files-in-pager")) {
    return "git grep -O запускает внешнюю программу";
  }
  return null;
}

function checkPnpm(args) {
  const [first, ...rest] = args;
  if (first === "test" || first === "ac:check") return hasUpdateFlag(rest) ? "флаг обновления снимков" : null;
  if (first === "exec" && rest[0] === "vitest") return checkVitest(rest.slice(1));
  if (first === "--filter" && rest.length === 2 && rest[1] === "test") return null;
  return "pnpm: разрешены test, ac:check, exec vitest, --filter <пакет> test";
}

const hasUpdateFlag = (args) => args.some((arg) => arg === "-u" || arg === "--update" || /^--update=/.test(arg));

function checkVitest(args) {
  if (hasUpdateFlag(args)) return "vitest -u обновляет снимки";
  if (hasOutputOption(args)) return "vitest --outputFile пишет в файл";
  return null;
}

function checkSegment(words) {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  const [name, ...args] = words.slice(index);
  if (!name) return "команда состоит только из присваиваний";
  if (name === "git") return checkGit(args);
  if (name === "pnpm") return checkPnpm(args);
  if (name === "vitest") return args[0] === "run" ? checkVitest(args.slice(1)) : "vitest: разрешён только run";
  if (name === "node") {
    const script = args[0]?.replace(/^\.\//, "");
    return NODE_SCRIPTS.has(script)
      ? null
      : "node: разрешены scripts/task.mjs, scripts/doc.mjs, scripts/check-ac-coverage.mjs";
  }
  if (!READ_COMMANDS.has(name)) return `команда ${name} не входит в список чтения`;
  if (name === "find" && args.some((arg) => FIND_WRITE_FLAGS.has(arg))) return "find с -delete, -exec и записью";
  if (
    name === "sed" &&
    args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))
  ) {
    return "sed -i правит файл";
  }
  if (name === "sort" && args.some((arg) => arg === "-o" || arg.startsWith("--output") || /^-[a-zA-Z]*o/.test(arg))) {
    return "sort -o пишет в файл";
  }
  return null;
}

// null, если команда разрешена, иначе причина отказа.
export function checkCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return "пустая команда";
  const { segments, reason } = tokenize(command);
  if (reason) return reason;
  if (segments.length === 0) return "пустая команда";
  for (const words of segments) {
    const problem = checkSegment(words);
    if (problem) return problem;
  }
  return null;
}

function main() {
  // Непонятный вход блокирует вызов: хук должен отказывать, а не пропускать молча.
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("Хук verifier-bash-guard не смог разобрать вход Claude Code, вызов заблокирован.\n");
    process.exit(2);
  }
  const problem = checkCommand(input.tool_input?.command);
  if (problem) {
    process.stderr.write(
      `sh-verifier ничего не меняет: разрешены команды чтения (git diff, git log, git show, cat, grep, ls, head, tail, wc, find без -exec) и запуск тестов (pnpm test, pnpm exec vitest run). Заблокировано: ${problem}.\n`,
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
