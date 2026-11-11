#!/usr/bin/env node
// `pnpm status`: короткая сводка для штаба и владельца (docs/process.md §7).
// 1. Задачи в статусах Ready, In Progress и Review из backlog/tasks (файлы той папки, где запущен скрипт).
// 2. Открытые PR и состояние CI из `gh pr list`. Нет `gh` или он не отвечает: печатает «PR недоступны» и причину.
// 3. Worktree с их ветками из `git worktree list`.
// Скрипт только читает, ничего не меняет.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const STATUSES = ["Ready", "In Progress", "Review"];
// Итоги проверки, которые не считаем провалом.
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const OK_STATES = new Set(["SUCCESS"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error)
    return { ok: false, reason: `${command} не запускается: ${result.error.code ?? result.error.message}` };
  if (result.status !== 0) {
    const firstLine = `${result.stderr}${result.stdout}`.trim().split("\n")[0];
    return { ok: false, reason: `${command} завершился с кодом ${result.status}${firstLine ? `: ${firstLine}` : ""}` };
  }
  return { ok: true, stdout: result.stdout };
}

export function readTasks(root) {
  const dir = join(root, "backlog/tasks");
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, name), "utf8"));
    const meta = front ? YAML.parse(front[1]) : {};
    return {
      id: String(meta.id ?? "").toUpperCase(),
      title: String(meta.title ?? ""),
      status: String(meta.status ?? ""),
    };
  });
}

// Состояние CI по statusCheckRollup: красный, идёт, зелёный или «нет проверок».
export function ciState(checks) {
  if (!checks || checks.length === 0) return "CI нет";
  let pending = false;
  for (const check of checks) {
    if (check.state !== undefined) {
      if (PENDING_STATES.has(check.state)) pending = true;
      else if (!OK_STATES.has(check.state)) return "CI красный";
    } else if (check.status !== "COMPLETED") {
      pending = true;
    } else if (!OK_CONCLUSIONS.has(check.conclusion)) {
      return "CI красный";
    }
  }
  return pending ? "CI идёт" : "CI зелёный";
}

function openPrs() {
  const result = run("gh", ["pr", "list", "--state", "open", "--json", "number,title,headRefName,statusCheckRollup"]);
  if (!result.ok) return result;
  try {
    return { ok: true, prs: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: "gh вернул не JSON" };
  }
}

function worktrees() {
  const result = run("git", ["worktree", "list", "--porcelain"]);
  if (!result.ok) return result;
  const items = result.stdout
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
      return path ? { name: basename(path), branch: branch ?? "(без ветки)" } : null;
    })
    .filter(Boolean);
  return { ok: true, items };
}

function main() {
  const top = run("git", ["rev-parse", "--show-toplevel"]);
  const root = top.ok ? top.stdout.trim() : process.cwd();
  const lines = [];

  const tasks = readTasks(root);
  for (const status of STATUSES) {
    const items = tasks.filter((task) => task.status === status);
    lines.push(`${status} (${items.length})`);
    for (const task of items) lines.push(`  ${task.id} ${task.title}`);
  }

  lines.push("Открытые PR");
  const prs = openPrs();
  if (!prs.ok) lines.push(`  PR недоступны: ${prs.reason}`);
  else if (prs.prs.length === 0) lines.push("  нет");
  else {
    for (const pr of prs.prs)
      lines.push(`  #${pr.number} ${pr.title} [${pr.headRefName}] ${ciState(pr.statusCheckRollup)}`);
  }

  lines.push("Worktree");
  const trees = worktrees();
  if (!trees.ok) lines.push(`  недоступны: ${trees.reason}`);
  else for (const tree of trees.items) lines.push(`  ${tree.name}  ${tree.branch}`);

  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
