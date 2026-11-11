#!/usr/bin/env node
// `pnpm sync`: приводит основную папку клона в порядок после слияний PR (docs/process.md §9).
// Запускается в основной папке. Без флага ничего не меняет, только показывает:
// 1. насколько локальный main отстаёт от origin/main;
// 2. незакоммиченные файлы задач backlog/, содержимое которых совпадает с origin/main (устаревшие копии);
// 3. локальные ветки, удалённые на GitHub (тот же список, что у `pnpm git:prune`).
// С флагом --apply: сбрасывает только совпавшие файлы задач, подтягивает main перемоткой (--ff-only)
// и удаляет только показанные ветки. Любые другие незакоммиченные правки скрипт не трогает.
// Историю, которую нельзя перемотать, скрипт не сливает и не переписывает: сообщает и выходит с кодом 1 при --apply.
// `git fetch --all --prune` обновляет только ссылки origin/*, рабочую папку и локальные ветки не меняет.
import { readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { goneBranches } from "./git-prune.mjs";
import { git, tryGit } from "./lib/git.mjs";

const TARGET = "origin/main";
const TASKS_DIR = "backlog/";
// Коды `git status --porcelain` (X: индекс, Y: рабочая папка), при которых файл может быть устаревшей копией:
// не отслеживается, изменён в рабочей папке, в индексе или в обоих местах, добавлен в индекс.
// Удаления, конфликты и всё остальное считаем чужими правками и не трогаем.
const COPY_CODES = new Set(["??", " M", "M ", "MM", "A ", "AM"]);

// Незакоммиченные файлы из `git status`: код XY и путь.
function dirtyFiles() {
  return git(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"])
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
}

const isUntracked = ({ code }) => code === "??";

// Файл совпадает с origin/main: рабочая копия побайтно, а если в индекс что-то добавлено (X не пробел), то и версия в индексе.
// Иначе в индексе лежит чья-то правка, и сброс её потеряет.
function matchesTarget({ code, path }) {
  if (!COPY_CODES.has(code)) return false;
  const remote = tryGit(["show", `${TARGET}:${path}`], { binary: true });
  if (!remote.ok) return false;
  try {
    if (!readFileSync(path).equals(remote.stdout)) return false;
  } catch {
    return false;
  }
  if (isUntracked({ code }) || code[0] === " ") return true;
  const staged = tryGit(["rev-parse", `:${path}`]);
  const target = tryGit(["rev-parse", `${TARGET}:${path}`]);
  return staged.ok && target.ok && staged.stdout.trim() === target.stdout.trim();
}

// Возвращает файл к HEAD. Файла нет в HEAD (не отслеживается или только добавлен в индекс): убираем из индекса и удаляем.
function resetFile(file) {
  if (!isUntracked(file) && tryGit(["cat-file", "-e", `HEAD:${file.path}`]).ok) {
    git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
    return;
  }
  if (!isUntracked(file)) git(["rm", "--cached", "--quiet", "--", file.path]);
  unlinkSync(file.path);
}

const count = (range) => Number(git(["rev-list", "--count", range]).trim());

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    process.stderr.write(`Неизвестный аргумент: ${unknown.join(" ")}\nИспользование: pnpm sync [--apply]\n`);
    process.exit(1);
  }
  const apply = args.includes("--apply");
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  const say = (text) => process.stdout.write(`${text}\n`);

  git(["fetch", "--all", "--prune", "--quiet"]);
  if (!tryGit(["rev-parse", "--verify", "--quiet", TARGET]).ok) {
    process.stderr.write(`Нет ссылки ${TARGET}: проверьте remote origin.\n`);
    process.exit(1);
  }

  const branch = git(["branch", "--show-current"]).trim();
  const behind = count(`HEAD..${TARGET}`);
  const ahead = count(`${TARGET}..HEAD`);
  let canPull = false;
  let pullFailed = false;

  say(`main: ${branch ? `ветка ${branch}` : "HEAD отсоединён"}`);
  if (branch !== "main") {
    say(`  Основная папка не на main: main не подтягиваю.`);
  } else if (behind > 0 && ahead > 0) {
    say(`  История разошлась с ${TARGET} (впереди ${ahead}, позади ${behind}): нельзя перемотать, слияние не делаю.`);
    say(`  Разберитесь вручную: git log --oneline --graph main ${TARGET}`);
    pullFailed = true;
  } else if (behind > 0) {
    say(`  Основная папка отстаёт от ${TARGET} на ${behind} коммитов.`);
    canPull = true;
  } else {
    say(ahead > 0 ? `  Впереди ${TARGET} на ${ahead} коммитов, подтягивать нечего.` : `  Актуален.`);
    canPull = true;
  }

  const dirty = dirtyFiles();
  const taskFiles = dirty.filter(({ path }) => path.startsWith(TASKS_DIR));
  const stale = taskFiles.filter(matchesTarget);
  const own = taskFiles.filter((file) => !stale.includes(file));
  const otherDirty = dirty.length - taskFiles.length;

  say("Файлы задач, совпадающие с main (устаревшие копии):");
  say(stale.length === 0 ? "  нет" : stale.map(({ path }) => `  ${path}`).join("\n"));
  if (stale.length > 0 && !canPull) say("  Сбрасывать не буду: main не подтягивается.");
  if (own.length > 0) {
    say("Незакоммиченные файлы задач, отличные от main (не трогаю):");
    say(own.map(({ path }) => `  ${path}`).join("\n"));
  }
  if (otherDirty > 0) say(`Другие незакоммиченные файлы: ${otherDirty} (не трогаю).`);

  const gone = goneBranches();
  say("Ветки, удалённые на GitHub:");
  say(gone.length === 0 ? "  нет" : gone.map(({ name }) => `  ${name}`).join("\n"));

  if (!apply) {
    say("Применить: pnpm sync --apply");
    return;
  }

  if (canPull) {
    for (const file of stale) {
      resetFile(file);
      say(`Сброшен файл ${file.path}`);
    }
    if (behind > 0) {
      const merged = tryGit(["merge", "--ff-only", "--quiet", TARGET]);
      if (merged.ok) say(`main подтянут до ${git(["rev-parse", "--short", "HEAD"]).trim()}`);
      else {
        say(`Перемотать main не удалось: ${merged.stderr}`);
        pullFailed = true;
      }
    }
  }
  for (const { name, sha } of gone) {
    git(["branch", "-D", "--quiet", name]);
    say(`Удалена ветка ${name} (было ${sha})`);
  }
  if (gone.length > 0) say("Вернуть ветку: git branch <имя> <SHA>");
  if (pullFailed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
