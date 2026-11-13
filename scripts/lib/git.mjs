// Общие вызовы git для скриптов `pnpm git:prune` и `pnpm sync`.
import { spawnSync } from "node:child_process";

// Запускает git и возвращает { ok, stdout, stderr } без завершения процесса. С binary stdout приходит буфером.
export function tryGit(args, { binary = false } = {}) {
  const result = spawnSync("git", args, { encoding: binary ? "buffer" : "utf8" });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: String(result.stderr ?? "").trim(),
  };
}

// Запускает git и возвращает stdout. Ошибка git печатается, процесс завершается с тем же кодом.
export function git(args) {
  const result = tryGit(args);
  if (!result.ok) {
    process.stderr.write(`${result.stderr}\n`);
    process.stderr.write(`Команда git ${args.join(" ")} завершилась с кодом ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

// Worktree клона по `git worktree list --porcelain`. Первая запись — основная папка.
export function listWorktrees() {
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
