#!/usr/bin/env node
// После успешной выкладки переводит в Done задачи в статусе Merged, чьи squash-коммиты
// (сообщение `^SH-NNN:` в origin/main) — предки выложенного SHA. Для каждой такой задачи
// открывает PR «Done: SH-…» с автослиянием (gh pr create + gh pr merge --auto --squash)
// и ставит статус Done правкой файла карточки.
// Использование: node scripts/mark-done.mjs <SHA>
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Запускает команду и возвращает { status, stdout, stderr }. При ошибке запуска бросает.
// allowFail: ненулевой код не завершает процесс (нужно для `git merge-base --is-ancestor`).
function run(cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!allowFail && status !== 0) {
    process.stderr.write(`${cmd} ${args.join(" ")}: ${String(result.stderr ?? "").trim()}\n`);
    process.exit(status);
  }
  return { status, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
}

// Значение поля фронтматтера (`id`, `status`) без кавычек.
function frontMatterField(text, field) {
  const match = new RegExp(`^${field}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m").exec(text);
  return match?.[1]?.trim() ?? "";
}

// Находит задачи в Merged, чьи squash-коммиты — предки sha, ставит Done и открывает PR.
// Возвращает ID задач, переведённых в Done.
export function markDone(sha, { cwd = process.cwd() } = {}) {
  const tasksDir = join(cwd, "backlog/tasks");
  let names;
  try {
    names = readdirSync(tasksDir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }

  const done = [];
  for (const name of names.sort()) {
    const file = join(tasksDir, name);
    const text = readFileSync(file, "utf8");
    const id = frontMatterField(text, "id").toUpperCase();
    const status = frontMatterField(text, "status");
    if (!id || status !== "Merged") continue;

    // Squash-коммит задачи в origin/main: первое совпадение по `^SH-NNN:` в сообщении.
    const log = run("git", ["log", "origin/main", "--grep", `^${id}:`, "--format=%H"]);
    const commit = log.stdout.split("\n")[0];
    if (!commit) continue;

    // Только если squash-коммит — предок выложенного SHA.
    const ancestor = run("git", ["merge-base", "--is-ancestor", commit, sha], { allowFail: true });
    if (ancestor.status !== 0) continue;

    const title = `Done: ${id}`;
    const created = run("gh", ["pr", "create", "--title", title, "--body", `Автоматически: ${id} выложена в prod.`]);
    let number = null;
    try {
      number = JSON.parse(created.stdout).number;
    } catch {
      // Номер PR не критичен: `gh pr merge` без номера возьмёт PR текущей ветки.
    }
    const mergeArgs = ["pr", "merge"];
    if (number != null) mergeArgs.push(String(number));
    mergeArgs.push("--auto", "--squash");
    run("gh", mergeArgs);

    writeFileSync(file, text.replace(/^(status:\s*)['"]?Merged['"]?(\s*)$/m, "$1Done$2"));
    done.push(id);
  }
  return done;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const sha = process.argv[2];
  if (!sha) {
    process.stderr.write("Использование: node scripts/mark-done.mjs <SHA>\n");
    process.exit(1);
  }
  markDone(sha);
}
