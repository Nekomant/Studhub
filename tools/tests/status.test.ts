import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-080: скрипт `scripts/status.mjs` (`pnpm status`).
// Фикстура: репозиторий с задачами в разных статусах, второй worktree и подставной `gh` в PATH.
// ID задач в фикстурах из диапазона SH-9xx.

const script = resolve(import.meta.dirname, "../../scripts/status.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "status-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const tasks: [string, string][] = [
  ["SH-901", "Ready"],
  ["SH-902", "In Progress"],
  ["SH-903", "Review"],
  ["SH-904", "Done"],
  ["SH-905", "Backlog"],
];

const repo = join(workDir, "repo");
mkdirSync(join(repo, "backlog/tasks"), { recursive: true });
git(workDir, "init", "-q", "-b", "main", repo);
for (const [id, status] of tasks) {
  writeFileSync(
    join(repo, `backlog/tasks/${id.toLowerCase()} - t.md`),
    `---\nid: ${id}\ntitle: Название ${id}\nstatus: ${status}\n---\n\nОписание.\n`,
  );
}
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");
git(repo, "worktree", "add", "-q", "-b", "sh-902-feature", join(workDir, "wt-feature"));

const gitPath = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

// PATH из одной папки: в ней только git и, если нужно, подставной gh.
function binDir(name: string, ghJson?: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  symlinkSync(gitPath, join(dir, "git"));
  if (ghJson !== undefined) {
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/bin/sh\necho '${ghJson}'\n`);
    chmodSync(gh, 0o755);
  }
  return dir;
}

function runStatus(path: string) {
  const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8", env: { PATH: path } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const check = (name: string, status: string, conclusion: string) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});

describe("pnpm status", () => {
  it("[SH-080 AC-6] печатает задачи Ready, In Progress и Review, открытые PR с CI и worktree с ветками", () => {
    const prs = [
      {
        number: 17,
        title: "SH-902: Фича",
        headRefName: "sh-902-feature",
        statusCheckRollup: [check("checks", "COMPLETED", "SUCCESS")],
      },
      {
        number: 18,
        title: "SH-903: Другое",
        headRefName: "sh-903-x",
        statusCheckRollup: [check("checks", "COMPLETED", "FAILURE")],
      },
      {
        number: 19,
        title: "SH-906: Ждём",
        headRefName: "sh-906-y",
        statusCheckRollup: [check("checks", "IN_PROGRESS", "")],
      },
    ];
    const { code, out } = runStatus(binDir("bin-gh", JSON.stringify(prs)));

    expect(code).toBe(0);
    expect(out).toMatch(/Ready[^\n]*\n[^\n]*SH-901/);
    expect(out).toMatch(/In Progress[^\n]*\n[^\n]*SH-902/);
    expect(out).toMatch(/Review[^\n]*\n[^\n]*SH-903/);
    expect(out).not.toContain("SH-904");
    expect(out).not.toContain("SH-905");
    expect(out).toMatch(/#17[^\n]*sh-902-feature[^\n]*CI зелёный/);
    expect(out).toMatch(/#18[^\n]*CI красный/);
    expect(out).toMatch(/#19[^\n]*CI идёт/);
    expect(out).toContain("wt-feature");
    expect(out).toContain("sh-902-feature");
    expect(out).toMatch(/repo[^\n]*main/);
  });

  it("[SH-080 AC-6] без gh печатает задачи и сообщает, что PR недоступны", () => {
    const { code, out } = runStatus(binDir("bin-nogh"));

    expect(code).toBe(0);
    expect(out).toContain("SH-901");
    expect(out).toContain("SH-902");
    expect(out).toContain("SH-903");
    expect(out).toMatch(/PR недоступны/);
    expect(out).toContain("sh-902-feature");
  });
});
