#!/usr/bin/env node
// `pnpm git:prune`: находит локальные ветки, чья ветка на GitHub удалена после слияния PR.
// Обычный `git branch --merged` их не видит: после squash коммиты ветки не входят в историю main.
// 1. `git fetch --all --prune` убирает ветки, удалённые на GitHub, из origin/* (и из других remote).
// 2. Ветка попадает в список, если её upstream помечен [gone].
//    Ветки без upstream, main и ветки, открытые в любом worktree, скрипт пропускает.
// Без флага скрипт только печатает список. С флагом --delete удаляет ветки из списка (`git branch -D`)
// и печатает SHA каждой: ветку с несохранёнными коммитами можно вернуть командой `git branch <имя> <SHA>`.
import { spawnSync } from "node:child_process";

const PROTECTED = new Set(["main"]);

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(`Команда git ${args.join(" ")} завершилась с кодом ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

// Ветки, открытые в любом worktree клона, включая основную папку.
function branchesInWorktrees() {
  return new Set(
    git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length)),
  );
}

function goneBranches() {
  const inWorktrees = branchesInWorktrees();
  const format = "--format=%(refname:lstrip=2)%09%(upstream:track,nobracket)%09%(objectname:short)";
  return git(["for-each-ref", format, "refs/heads"])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name, track]) => name && track === "gone")
    .map(([name, , sha]) => ({ name, sha }))
    .filter(({ name }) => !PROTECTED.has(name) && !inWorktrees.has(name));
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = args.filter((arg) => arg !== "--delete");
if (unknown.length > 0) {
  process.stderr.write(`Неизвестный аргумент: ${unknown.join(" ")}\nИспользование: pnpm git:prune [--delete]\n`);
  process.exit(1);
}
const shouldDelete = args.includes("--delete");

git(["fetch", "--all", "--prune", "--quiet"]);
const branches = goneBranches();

if (branches.length === 0) {
  process.stdout.write("Локальных веток, удалённых на GitHub, нет.\n");
} else if (!shouldDelete) {
  process.stdout.write(
    `Ветки удалены на GitHub, локально остались:\n${branches.map(({ name }) => `  ${name}\n`).join("")}`,
  );
  process.stdout.write("Удалить их: pnpm git:prune --delete\n");
} else {
  for (const { name, sha } of branches) {
    git(["branch", "-D", "--quiet", name]);
    process.stdout.write(`Удалена ветка ${name} (было ${sha})\n`);
  }
  process.stdout.write("Вернуть ветку: git branch <имя> <SHA>\n");
}
