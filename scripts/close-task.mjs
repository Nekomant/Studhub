#!/usr/bin/env node
// `pnpm close-task SH-NNN [--apply]`: закрывает цикл задачи после слияния PR (docs/process.md §7.1, шаг 7).
// Запускается в основной папке клона. Перед проверками делает `git fetch --all --prune`.
// Вердикт строится из трёх проверок:
// 1. PR задачи слит: `gh pr list --state all`, PR с названием `SH-NNN: …`;
// 2. в origin/main у задачи статус Done: `git grep` по origin/main, файлы рабочей папки не читаются;
// 3. все checks PR завершились SUCCESS (SKIPPED и NEUTRAL допустимы).
// Без --apply ничего не меняет. С --apply и вердиктом «да»: перематывает main до origin/main, убирает чистый worktree
// задачи и удаляет локальную ветку PR, печатая её SHA. Грязный worktree остаётся и называется в выводе.
// Вывод до 12 строк, последняя: `ЗАКРЫТЬ СЕССИЮ: да` или `ЗАКРЫТЬ СЕССИЮ: нет (<причина>)`.
// Сессию задачи скрипт не архивирует: это делает штаб по вердикту.
// Коды выхода: 0 — «да»; 1 — «нет»; 2 — вердикт построить нельзя (gh недоступен, PR не найден или найдено несколько).
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { git, tryGit } from "./lib/git.mjs";
import { ciState } from "./status.mjs";
import { fastForwardMain, mainState } from "./sync.mjs";

const TARGET = "origin/main";
const MAX_LINES = 12;

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
  process.exit(code);
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
  const match = /^[^\n]*?:\d+:status:\s*(.+?)\s*$/m.exec(result.stdout);
  return match ? match[1].replace(/^["']|["']$/g, "") : null;
}

function listWorktrees() {
  return git(["worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
      return { path, branch: branch ?? null, head, detached: lines.includes("detached") };
    })
    .filter((tree) => tree.path);
}

// Worktree, который вела сессия задачи: на ветке PR, либо на отсоединённой голове в истории origin/main,
// где в журнале HEAD есть переход с ветки PR (после `git switch --detach origin/main`).
function taskWorktrees(branch, mainFolder) {
  const [primary, ...rest] = listWorktrees();
  return rest.filter((tree) => {
    if (tree.path === mainFolder || tree.path === primary.path) return false;
    if (tree.branch === branch) return true;
    if (!tree.detached || !tree.head) return false;
    const reflog = tryGit(["-C", tree.path, "reflog", "show", "--format=%gs", "HEAD"]);
    const moved = reflog.ok && reflog.stdout.split("\n").some((line) => line.includes(`moving from ${branch} to `));
    return moved && tryGit(["merge-base", "--is-ancestor", tree.head, TARGET]).ok;
  });
}

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
    process.exit(2);
  }
  const taskId = `SH-${id[1]}`;
  const lines = [];

  const top = tryGit(["rev-parse", "--show-toplevel"]);
  if (!top.ok) finish(lines, 2, "это не git-репозиторий");
  const mainFolder = top.stdout.trim();
  process.chdir(mainFolder);

  const fetched = tryGit(["fetch", "--all", "--prune", "--quiet"]);
  if (!fetched.ok) finish(lines, 2, `git fetch не удался: ${oneLine(fetched.stderr)}`);
  if (!tryGit(["rev-parse", "--verify", "--quiet", TARGET]).ok) finish(lines, 2, `нет ссылки ${TARGET}`);

  const found = findPr(taskId);
  if (found.error) {
    lines.push(`PR: ${oneLine(found.error)}`);
    finish(lines, 2, found.error);
  }
  const { pr } = found;
  const reasons = [];

  if (pr.state === "MERGED") lines.push(`PR #${pr.number}: слит`);
  else {
    lines.push(`PR #${pr.number}: не слит (${pr.state})`);
    reasons.push(`PR #${pr.number} не слит (${pr.state})`);
  }

  const status = statusInMain(taskId);
  lines.push(`Статус в ${TARGET}: ${status ?? "задача не найдена"}`);
  if (status !== "Done")
    reasons.push(status ? `статус в ${TARGET}: ${status}, нужен Done` : `задача не найдена в ${TARGET}`);

  const ci = ciState(pr.statusCheckRollup);
  if (ci === "CI красный") {
    lines.push("Checks: есть непройденные");
    reasons.push("checks PR не зелёные");
  } else if (ci === "CI идёт") {
    lines.push("Checks: ещё идут");
    reasons.push("checks PR ещё идут");
  } else lines.push(ci === "CI нет" ? "Checks: проверок у PR нет" : "Checks: зелёные");

  if (reasons.length > 0) finish(lines, 1, reasons.join("; "));
  if (!apply) {
    lines.push("Просмотр: ничего не менял. Убрать за задачей: --apply");
    finish(lines, 0, null);
  }

  const state = mainState();
  if (state.problem) {
    lines.push(`main: ${state.problem}`);
    finish(lines, 1, `main не перемотан: ${state.problem}`);
  }
  if (state.behind > 0) {
    const merged = fastForwardMain();
    if (!merged.ok) {
      lines.push(`main: перемотать не удалось: ${oneLine(merged.stderr)}`);
      finish(lines, 1, "main не перемотан");
    }
    lines.push(`main: подтянут до ${merged.sha}`);
  } else lines.push("main: актуален");

  const branch = pr.headRefName;
  const blocked = [];
  for (const tree of taskWorktrees(branch, mainFolder)) {
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
  else if (branch === "main" || blocked.length > 0) lines.push(`Ветка ${branch}: оставлена`);
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

  if (blocked.length > 0) finish(lines, 1, `не убрано: ${blocked.join(", ")}`);
  finish(lines, 0, null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
