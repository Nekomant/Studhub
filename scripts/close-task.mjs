#!/usr/bin/env node
// `pnpm close-task SH-NNN [--apply]`: закрывает цикл задачи после слияния PR (docs/process.md §7.1, шаг 7).
// Запускается из любой папки клона: основной, worktree задачи или чужого worktree. Основная папка берётся из первой
// записи `git worktree list --porcelain`, все операции (fetch, перемотка main, удаление веток и worktree) идут в ней.
// Перед проверками делает `git fetch --all --prune`.
// Вердикт строится из трёх проверок:
// 1. PR задачи слит: `gh pr list --state all`, PR с названием `SH-NNN: …`;
// 2. в origin/main у задачи статус Done: `git grep` по origin/main, файлы рабочей папки не читаются;
//    если в origin/main больше одного файла задачи, статус неоднозначен и вердикт «нет»;
// 3. все checks PR завершились SUCCESS (SKIPPED и NEUTRAL допустимы).
// Без --apply ничего не меняет. С --apply и вердиктом «да»: перематывает main до origin/main, убирает чистый worktree
// задачи и удаляет локальную ветку PR, печатая её SHA. Грязный worktree остаётся и называется в выводе.
// Папка запуска классифицируется: основная, worktree задачи или чужой worktree. Чужой worktree скрипт не трогает.
// Запуск из worktree задачи: сам этот worktree и ветку скрипт не удаляет, остальное делает, вердикт «нет»,
// код 1; штаб запускает команду повторно из основной папки, и она дочищает.
// Вывод до 12 строк, последняя: `ЗАКРЫТЬ СЕССИЮ: да` или `ЗАКРЫТЬ СЕССИЮ: нет (<причина>)`.
// Сессию задачи скрипт не архивирует: это делает штаб по вердикту.
// Коды выхода: 0 — «да»; 1 — «нет»; 2 — вердикт построить нельзя (gh недоступен, PR не найден или найдено несколько).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { listWorktrees, tryGit } from "./lib/git.mjs";
import { ciState } from "./status.mjs";
import { fastForwardMain, mainState } from "./sync.mjs";

const TARGET = "origin/main";
const MAX_LINES = 12;
const SELF_WORKTREE = "worktree этой сессии убирает штаб из основной папки";

const oneLine = (text) => {
  const first = String(text ?? "")
    .trim()
    .split("\n")[0]
    .trim();
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
};

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error)
    return { ok: false, reason: `${command} не запускается: ${result.error.code ?? result.error.message}` };
  if (result.status !== 0)
    return {
      ok: false,
      reason: `${command} завершился с кодом ${result.status}: ${oneLine(result.stderr || result.stdout)}`,
    };
  return { ok: true, stdout: result.stdout };
}

// Печать вывода: не больше MAX_LINES строк, последняя всегда вердикт. Лишние строки сворачиваются в одну.
function finish(lines, code, reason) {
  const verdict = reason === null ? "ЗАКРЫТЬ СЕССИЮ: да" : `ЗАКРЫТЬ СЕССИЮ: нет (${oneLine(reason)})`;
  const keep = MAX_LINES - 1;
  const body = lines.length > keep ? [...lines.slice(0, keep - 1), `… ещё ${lines.length - keep + 1} строк`] : lines;
  process.stdout.write(`${[...body, verdict].join("\n")}\n`);
  process.exitCode = code;
}

// PR задачи: название начинается с `SH-NNN: `. Поиск gh грубый, точное совпадение проверяем сами.
function findPr(id) {
  const result = run("gh", [
    "pr",
    "list",
    "--state",
    "all",
    "--search",
    `${id} in:title`,
    "--limit",
    "100",
    "--json",
    "number,title,state,headRefName,statusCheckRollup",
  ]);
  if (!result.ok) return { error: `gh недоступен: ${result.reason}` };
  let prs;
  try {
    prs = JSON.parse(result.stdout);
  } catch {
    return { error: "gh недоступен: вернул не JSON" };
  }
  const found = prs.filter((pr) => String(pr.title).startsWith(`${id}: `));
  if (found.length === 0) return { error: `PR задачи ${id} не найден` };
  if (found.length > 1)
    return { error: `найдено несколько PR задачи ${id}: ${found.map((pr) => `#${pr.number}`).join(", ")}` };
  return { pr: found[0] };
}

// Статус задачи в origin/main. Пробел перед `-*` обязателен: без него SH-08 совпал бы с SH-080.
function statusInMain(id) {
  const result = tryGit(["grep", "-n", "^status:", TARGET, "--", `backlog/tasks/${id.toLowerCase()} -*`]);
  if (!result.ok) return null;
  // Строки вида `origin/main:<файл>:<номер>:status: Done`. По каждому файлу берём первую строку status.
  const byFile = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = /^(.*?):(\d+):status:\s*(.*?)\s*$/.exec(
      line.startsWith(`${TARGET}:`) ? line.slice(TARGET.length + 1) : line,
    );
    if (match && !byFile.has(match[1])) byFile.set(match[1], match[3].replace(/^["']|["']$/g, ""));
  }
  if (byFile.size === 0) return null;
  if (byFile.size > 1) return { ambiguous: byFile.size };
  return { status: [...byFile.values()][0] };
}

// Worktree, который вела сессия задачи: на ветке PR, либо на отсоединённой голове в истории origin/main,
// где в журнале HEAD есть переход с ветки PR (после `git switch --detach origin/main`).
function taskWorktrees(branch) {
  const [, ...rest] = listWorktrees();
  return rest.filter((tree) => {
    if (tree.branch === branch) return true;
    if (!tree.detached || !tree.head) return false;
    const reflog = tryGit(["-C", tree.path, "reflog", "show", "--format=%gs", "HEAD"]);
    const moved = reflog.ok && reflog.stdout.split("\n").some((line) => line.includes(`moving from ${branch} to `));
    return moved && tryGit(["merge-base", "--is-ancestor", tree.head, TARGET]).ok;
  });
}

const sameDir = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

const isDirty = (path) => {
  const status = tryGit(["-C", path, "status", "--porcelain", "--untracked-files=all"]);
  return !status.ok || status.stdout.trim() !== "";
};

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const apply = args.includes("--apply");
  const rest = args.filter((arg) => arg !== "--apply");
  const id = rest.length === 1 ? /^SH-(\d+)$/i.exec(rest[0]) : null;
  if (!id) {
    process.stderr.write("Использование: pnpm close-task SH-NNN [--apply]\n");
    process.exitCode = 2;
    return;
  }
  const taskId = `SH-${id[1]}`;
  const lines = [];

  const top = tryGit(["rev-parse", "--show-toplevel"]);
  if (!top.ok) return finish(lines, 2, "это не git-репозиторий");
  const launchFolder = top.stdout.trim();
  // Основная папка: первая запись списка worktree. Все операции идут в ней, откуда бы ни запустили скрипт.
  const primaryFolder = listWorktrees()[0].path;
  process.chdir(primaryFolder);

  const fetched = tryGit(["fetch", "--all", "--prune", "--quiet"]);
  if (!fetched.ok) return finish(lines, 2, `git fetch не удался: ${oneLine(fetched.stderr)}`);
  if (!tryGit(["rev-parse", "--verify", "--quiet", TARGET]).ok) return finish(lines, 2, `нет ссылки ${TARGET}`);

  const found = findPr(taskId);
  if (found.error) {
    lines.push(`PR: ${oneLine(found.error)}`);
    return finish(lines, 2, found.error);
  }
  const { pr } = found;
  const reasons = [];

  if (pr.state === "MERGED") lines.push(`PR #${pr.number}: слит`);
  else {
    lines.push(`PR #${pr.number}: не слит (${pr.state})`);
    reasons.push(`PR #${pr.number} не слит (${pr.state})`);
  }

  const statusResult = statusInMain(taskId);
  if (statusResult?.ambiguous) {
    lines.push(`Статус в ${TARGET}: неоднозначен (файлов задачи: ${statusResult.ambiguous})`);
    reasons.push(`статус в ${TARGET} неоднозначен: файлов задачи ${statusResult.ambiguous}`);
  } else {
    const status = statusResult?.status ?? null;
    lines.push(`Статус в ${TARGET}: ${status ?? "задача не найдена"}`);
    if (status !== "Done")
      reasons.push(status ? `статус в ${TARGET}: ${status}, нужен Done` : `задача не найдена в ${TARGET}`);
  }

  const ci = ciState(pr.statusCheckRollup);
  if (ci === "CI красный") {
    lines.push("Checks: есть непройденные");
    reasons.push("checks PR не зелёные");
  } else if (ci === "CI идёт") {
    lines.push("Checks: ещё идут");
    reasons.push("checks PR ещё идут");
  } else lines.push(ci === "CI нет" ? "Checks: проверок у PR нет" : "Checks: зелёные");

  if (reasons.length > 0) return finish(lines, 1, reasons.join("; "));

  // Папка запуска: основная, worktree задачи или чужой worktree (чужие скрипт не трогает).
  const branch = pr.headRefName;
  const taskTrees = taskWorktrees(branch);
  const launchIsTask = taskTrees.some((tree) => sameDir(tree.path, launchFolder));
  if (!apply) {
    if (launchIsTask) lines.push(`Запуск из worktree задачи ${launchFolder}: его уберёт штаб из основной папки`);
    lines.push("Просмотр: ничего не менял. Убрать за задачей: --apply");
    return finish(lines, 0, null);
  }

  const state = mainState();
  if (state.problem) {
    lines.push(`main: ${state.problem}`);
    return finish(lines, 1, `main не перемотан: ${state.problem}`);
  }
  if (state.behind > 0) {
    const merged = fastForwardMain();
    if (!merged.ok) {
      lines.push(`main: перемотать не удалось: ${oneLine(merged.stderr)}`);
      return finish(lines, 1, "main не перемотан");
    }
    lines.push(`main: подтянут до ${merged.sha}`);
  } else lines.push("main: актуален");

  const blocked = [];
  let selfKept = false;
  for (const tree of taskTrees) {
    if (sameDir(tree.path, launchFolder)) {
      lines.push(`Worktree ${tree.path}: папка запуска, не удаляю`);
      selfKept = true;
      continue;
    }
    if (isDirty(tree.path)) {
      lines.push(`Worktree ${tree.path}: есть незакоммиченные файлы, не трогаю`);
      blocked.push(tree.path);
      continue;
    }
    const removed = tryGit(["worktree", "remove", tree.path]);
    if (removed.ok) lines.push(`Worktree ${tree.path}: удалён`);
    else {
      lines.push(`Worktree ${tree.path}: не удалён: ${oneLine(removed.stderr)}`);
      blocked.push(tree.path);
    }
  }

  const sha = tryGit(["rev-parse", "--short", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!sha.ok) lines.push(`Ветка ${branch}: локально нет`);
  else if (branch === "main" || selfKept || blocked.length > 0) lines.push(`Ветка ${branch}: оставлена`);
  else {
    const deleted = tryGit(["branch", "-D", "--quiet", branch]);
    if (deleted.ok)
      lines.push(
        `Ветка ${branch}: удалена (было ${sha.stdout.trim()}), вернуть: git branch ${branch} ${sha.stdout.trim()}`,
      );
    else {
      lines.push(`Ветка ${branch}: не удалена: ${oneLine(deleted.stderr)}`);
      blocked.push(branch);
    }
  }

  const unfinished = [];
  if (selfKept) unfinished.push(SELF_WORKTREE);
  if (blocked.length > 0) unfinished.push(`не убрано: ${blocked.join(", ")}`);
  if (unfinished.length > 0) return finish(lines, 1, unfinished.join("; "));
  return finish(lines, 0, null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
