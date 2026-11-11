#!/usr/bin/env node
// Настройки git для клона и всех его worktree. Запускается из `postinstall` при `pnpm install`.
// core.quotepath false: `git status` показывает кириллические пути как есть, без восьмеричных кодов.
// Worktree делят конфиг основного клона, поэтому одной записи хватает на все.
// Вне git-репозитория (например, в сборке без .git) скрипт ничего не делает.
import { spawnSync } from "node:child_process";

const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
if (inside.status === 0 && inside.stdout.trim() === "true") {
  const result = spawnSync("git", ["config", "core.quotepath", "false"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
