import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-078: скрипт очистки локальных веток `pnpm git:prune`.
// Каждый тест собирает свой репозиторий: bare-репозиторий играет роль GitHub,
// клон — рабочую папку разработчика. Скрипт запускается отдельным процессом в клоне.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/git-prune.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "git-prune-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// Переменные GIT_* снаружи (например, из git-хука) не должны попасть во временный репозиторий.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });

// Ветки в клоне:
// - gone: ушла с GitHub после слияния, должна попасть в список;
// - in-worktree: ушла с GitHub, но открыта в другом worktree;
// - local-only: без upstream;
// - alive: ветка на GitHub ещё есть;
// - main: ушла с GitHub (искусственно), но клон стоит на alive, так что main не в worktree.
let counter = 0;
function setup() {
  counter += 1;
  const origin = join(workDir, `origin-${counter}.git`);
  const clone = join(workDir, `clone-${counter}`);
  const worktree = join(workDir, `clone-${counter}-wt`);
  git(workDir, "init", "-q", "--bare", "-b", "main", origin);
  git(workDir, "clone", "-q", origin, clone);
  git(clone, "commit", "-q", "--allow-empty", "-m", "init");
  git(clone, "push", "-q", "-u", "origin", "main");
  for (const branch of ["gone", "in-worktree", "alive"]) {
    git(clone, "branch", branch);
    git(clone, "push", "-q", "-u", "origin", branch);
  }
  git(clone, "branch", "local-only");
  git(clone, "switch", "-q", "alive");
  git(clone, "worktree", "add", "-q", worktree, "in-worktree");
  for (const branch of ["gone", "in-worktree", "main"]) {
    git(origin, "update-ref", "-d", `refs/heads/${branch}`);
  }
  return { clone };
}

function prune(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const localBranches = (cwd: string) =>
  git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();

describe("[SH-078 AC-3] список веток, ушедших с GitHub", () => {
  it("[SH-078 AC-3] package.json запускает скрипт командой git:prune", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["git:prune"]).toContain("scripts/git-prune.mjs");
  });

  it("[SH-078 AC-3] после fetch --prune в списке только ветка с [gone]", () => {
    const { clone } = setup();
    const result = prune(clone);
    expect(result.status).toBe(0);
    const listed = result.output.split("\n").filter((line) => /^\s+\S/.test(line));
    expect(listed.map((line) => line.trim())).toEqual(["gone"]);
  });

  it("[SH-078 AC-3] ветки в worktree, без upstream, живые и main в список не попадают", () => {
    const { clone } = setup();
    const { status, output } = prune(clone);
    expect(status).toBe(0);
    expect(output).toMatch(/^\s+gone$/m);
    for (const branch of ["in-worktree", "local-only", "alive", "main"]) {
      expect(output).not.toMatch(new RegExp(`^\\s+${branch}$`, "m"));
    }
  });

  it("[SH-078 AC-3] если ушедших веток нет, скрипт так и пишет", () => {
    const { clone } = setup();
    git(clone, "branch", "-D", "gone");
    const result = prune(clone);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/нет/i);
  });
});

describe("[SH-078 AC-4] удаление только с флагом", () => {
  it("[SH-078 AC-4] без флага ни одна ветка не удаляется", () => {
    const { clone } = setup();
    const before = localBranches(clone);
    expect(prune(clone).status).toBe(0);
    expect(localBranches(clone)).toEqual(before);
  });

  it("[SH-078 AC-4] с --delete удаляется только ветка из списка, и скрипт печатает её имя", () => {
    const { clone } = setup();
    const result = prune(clone, "--delete");
    expect(result.status).toBe(0);
    expect(localBranches(clone)).toEqual(["alive", "in-worktree", "local-only", "main"]);
    expect(result.output).toMatch(/Удалена.*gone/);
  });
});
