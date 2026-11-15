import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-107 AC-7 и AC-8: скрипт `scripts/mark-done.mjs` после успешной выкладки находит задачи
// в статусе Merged, чьи squash-коммиты (`^SH-NNN:` в origin/main) — предки выложенного SHA, открывает
// PR «Done: SH-…» с автослиянием и ставит задаче Done. Каждый тест строит временный bare-репозиторий
// и клон: в origin/main лежат задачи SH-901 и SH-902 в Merged; squash SH-901 — предок выложенного SHA,
// squash SH-902 — потомок (не предок). `gh` подменяется заглушкой в PATH и пишет вызовы в журнал; git — настоящий.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/mark-done.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "mark-done-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Заглушка gh: пишет `gh <аргументы> cwd=<папка>` в журнал FAKE_LOG и отвечает JSON PR.
const fakeBin = join(workDir, "bin");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, "gh"),
  `#!/bin/sh
echo "gh $* cwd=$PWD" >> "$FAKE_LOG"
echo '{"url":"https://github.com/example/pull/1","number":1}'
`,
);
chmodSync(join(fakeBin, "gh"), 0o755);

const taskFile = (id: string, status: string) => `---
id: ${id}
title: 'Задача ${id.slice(3)}'
status: ${status}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Сделать работу.
<!-- SECTION:DESCRIPTION:END -->
`;

let counter = 0;

// История: init (задачи Merged) → squash `SH-901:` → выкладка (возвращаемый SHA) → squash `SH-902:`.
// Выложенный SHA — коммит выкладки: SH-901 его предок, SH-902 — потомок (не предок).
function makeRepo() {
  counter += 1;
  const base = join(workDir, `case-${counter}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  mkdirSync(base, { recursive: true });
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");

  mkdirSync(join(seed, "backlog/tasks"), { recursive: true });
  writeFileSync(join(seed, "backlog/tasks/sh-901 - задача A.md"), taskFile("SH-901", "Merged"));
  writeFileSync(join(seed, "backlog/tasks/sh-902 - задача B.md"), taskFile("SH-902", "Merged"));
  writeFileSync(join(seed, "README.md"), "readme\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "main");

  writeFileSync(join(seed, "a.txt"), "A\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "SH-901: задача A");
  git(seed, "push", "-q", "origin", "main");

  writeFileSync(join(seed, "deploy.txt"), "deploy\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "deploy-v1");
  git(seed, "push", "-q", "origin", "main");
  const deployedSha = git(seed, "rev-parse", "HEAD");

  writeFileSync(join(seed, "b.txt"), "B\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "SH-902: задача B");
  git(seed, "push", "-q", "origin", "main");

  git(base, "clone", "-q", origin, work);
  git(work, "config", "user.name", "test");
  git(work, "config", "user.email", "test@example.com");
  return { base, seed, work, deployedSha, log: join(base, "fake.log") };
}

function runMarkDone(work: string, sha: string, log: string) {
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, [script, sha], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_LOG: log },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: readFileSync(log, "utf8") };
}

const statusOf = (file: string) => {
  const text = readFileSync(file, "utf8");
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  return String(YAML.parse(front?.[1] ?? "{}").status ?? "");
};

describe("mark-done: задачи в Merged с предком выложенного SHA", () => {
  it("[SH-107 AC-7] задача-предок: PR «Done: SH-901» с автослиянием и статус Done", () => {
    const s = makeRepo();

    const { code, out, calls } = runMarkDone(s.work, s.deployedSha, s.log);

    expect(code, out).toBe(0);
    expect(calls).toContain("gh pr create");
    expect(calls).toContain("Done: SH-901");
    expect(calls).toContain("gh pr merge");
    expect(calls).toContain("--auto");
    expect(calls).toContain("--squash");
    expect(statusOf(join(s.work, "backlog/tasks/sh-901 - задача A.md"))).toBe("Done");
  });

  it("[SH-107 AC-7] задача не предок: без PR и статус не меняется", () => {
    const s = makeRepo();

    const { code, out, calls } = runMarkDone(s.work, s.deployedSha, s.log);

    expect(code, out).toBe(0);
    expect(calls).not.toContain("Done: SH-902");
    expect(statusOf(join(s.work, "backlog/tasks/sh-902 - задача B.md"))).toBe("Merged");
  });
});

describe("mark-done: шаг Done только при зелёном deploy", () => {
  it("[SH-107 AC-8] шаг Done в job deploy запускается только при успехе", () => {
    const workflow = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: { deploy: { steps: { run?: string; if?: string }[] } };
    };
    const steps = workflow.jobs.deploy.steps;
    const done = steps.find((step) => step.run?.includes("mark-done.mjs"));
    expect(done, "нет шага mark-done.mjs в job deploy").toBeDefined();
    // Если условие задано явно, оно должно требовать успеха; без условия шаг и так пропускается при падении.
    if (done?.if) {
      expect(done.if, "шаг Done должен выполняться только при успешной выкладке").toMatch(/success\(\)|!failure\(\)/);
    }
  });
});
