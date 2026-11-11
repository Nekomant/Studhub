import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-080: скрипт `scripts/sync.mjs` (`pnpm sync`).
// Каждый тест собирает во временной папке свой «GitHub» (bare-репозиторий), основную папку и второй клон,
// который двигает origin/main. ID задач в фикстурах из диапазона SH-9xx.

const script = resolve(import.meta.dirname, "../../scripts/sync.mjs");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "sync-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const taskFile = (id: string, status: string, extra = "") =>
  `---\nid: ${id}\ntitle: Задача ${id}\nstatus: ${status}\n---\n\nОписание.\n${extra}`;

const TASK_A = "backlog/tasks/sh-901 - a.md";
const TASK_B = "backlog/tasks/sh-902 - b.md";

type Repos = { origin: string; work: string; other: string };

let counter = 0;
function makeRepos(): Repos {
  counter += 1;
  const base = join(workDir, `case-${counter}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  const other = join(base, "other");
  mkdirSync(base, { recursive: true });
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  mkdirSync(join(seed, "backlog/tasks"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "readme\n");
  writeFileSync(join(seed, TASK_A), taskFile("SH-901", "Backlog"));
  writeFileSync(join(seed, TASK_B), taskFile("SH-902", "Backlog"));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, work);
  git(base, "clone", "-q", origin, other);
  return { origin, work, other };
}

// Второй клон двигает origin/main: задача SH-901 становится Ready (как после слияния PR спецификаций).
function moveOriginMain({ other }: Repos, file = TASK_A, content = taskFile("SH-901", "Ready")) {
  writeFileSync(join(other, file), content);
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "ready");
  git(other, "push", "-q", "origin", "main");
}

function runSync(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (cwd: string, file: string) => readFileSync(join(cwd, file), "utf8");
const branches = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");

// Основная папка с отставанием на 1 коммит, копией Ready, своей правкой чужой задачи
// и двумя ветками: одна удалена на GitHub, вторая никогда не пушилась.
function messyCase() {
  const repos = makeRepos();
  const { work, other } = repos;
  git(work, "branch", "sh-903-old");
  git(work, "push", "-q", "-u", "origin", "sh-903-old");
  git(work, "branch", "local-only");
  git(other, "push", "-q", "origin", "--delete", "sh-903-old");
  moveOriginMain(repos);
  writeFileSync(join(work, TASK_A), taskFile("SH-901", "Ready"));
  writeFileSync(join(work, TASK_B), taskFile("SH-902", "Backlog", "Моя правка, ещё не закоммичена.\n"));
  return repos;
}

describe("pnpm sync: показ и применение", () => {
  it("[SH-080 AC-4] без флага ничего не меняет и показывает отставание, копию задачи и удалённую ветку", () => {
    const { work } = messyCase();
    const headBefore = git(work, "rev-parse", "HEAD");
    const statusBefore = git(work, "status", "--porcelain");
    const branchesBefore = branches(work);

    const { code, out } = runSync(work);

    expect(code).toBe(0);
    expect(out).toMatch(/отстаёт от origin\/main на 1/);
    expect(out).toContain("sh-901");
    expect(out).toContain("sh-903-old");
    expect(out).not.toContain("local-only");
    expect(out).toContain("pnpm sync --apply");
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(work, "status", "--porcelain")).toBe(statusBefore);
    expect(branches(work)).toEqual(branchesBefore);
    expect(read(work, TASK_A)).toContain("status: Ready");
  });

  it("[SH-080 AC-4] с флагом подтягивает main, сбрасывает только совпадающую копию и удаляет показанную ветку", () => {
    const { work } = messyCase();
    const originMain = git(work, "rev-parse", "origin/main");

    const { code, out } = runSync(work, "--apply");

    expect(code).toBe(0);
    expect(out).toContain("sh-903-old");
    git(work, "fetch", "-q", "origin");
    expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
    expect(git(work, "rev-parse", "HEAD")).not.toBe(originMain);
    expect(read(work, TASK_A)).toContain("status: Ready");
    // Совпавшая копия сброшена: файл чистый, незакоммиченных правок у него нет.
    expect(git(work, "status", "--porcelain", "--", TASK_A)).toBe("");
    // Чужая правка осталась как была.
    expect(read(work, TASK_B)).toContain("Моя правка, ещё не закоммичена.");
    expect(git(work, "status", "--porcelain", "--", TASK_B)).toMatch(/^ ?M/);
    expect(branches(work)).not.toContain("sh-903-old");
    expect(branches(work)).toContain("local-only");
    expect(branches(work)).toContain("main");
  });

  it("[SH-080 AC-4] незакоммиченный файл вне backlog/ и неотслеживаемая своя заметка остаются на месте", () => {
    const { work } = messyCase();
    writeFileSync(join(work, "README.md"), "моя правка readme\n");
    writeFileSync(join(work, "notes.txt"), "заметка\n");

    runSync(work, "--apply");

    expect(read(work, "README.md")).toBe("моя правка readme\n");
    expect(existsSync(join(work, "notes.txt"))).toBe(true);
  });
});

const TASK_C = "backlog/tasks/sh-903 - c.md";

describe("pnpm sync: статусы индекса и рабочей папки", () => {
  it("[SH-080 AC-4] добавленный в индекс файл, которого нет в HEAD и который совпадает с main, сбрасывается без ошибки", () => {
    const repos = makeRepos();
    const { work } = repos;
    git(work, "branch", "sh-904-old");
    git(work, "push", "-q", "-u", "origin", "sh-904-old");
    git(repos.other, "push", "-q", "origin", "--delete", "sh-904-old");
    moveOriginMain(repos, TASK_C, taskFile("SH-903", "Ready"));
    writeFileSync(join(work, TASK_C), taskFile("SH-903", "Ready"));
    git(work, "add", TASK_C);

    const { code } = runSync(work, "--apply");

    expect(code).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(branches(work)).not.toContain("sh-904-old");
  });

  it("[SH-080 AC-4] изменение, добавленное в индекс и совпадающее с main, сбрасывается", () => {
    const repos = makeRepos();
    const { work } = repos;
    moveOriginMain(repos);
    writeFileSync(join(work, TASK_A), taskFile("SH-901", "Ready"));
    git(work, "add", TASK_A);

    const { code } = runSync(work, "--apply");

    expect(code).toBe(0);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(read(work, TASK_A)).toContain("status: Ready");
  });

  it("[SH-080 AC-4] в индексе чужая версия, в рабочей папке версия main: ничего не сбрасывается", () => {
    const repos = makeRepos();
    const { work } = repos;
    moveOriginMain(repos, TASK_C, taskFile("SH-903", "Ready"));
    writeFileSync(join(work, TASK_C), taskFile("SH-903", "Backlog", "Своя версия.\n"));
    git(work, "add", TASK_C);
    writeFileSync(join(work, TASK_C), taskFile("SH-903", "Ready"));
    const headBefore = git(work, "rev-parse", "HEAD");

    const { code, out } = runSync(work, "--apply");

    expect(code).toBe(1);
    expect(out).toContain("Перемотать main не удалось");
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(work, "show", `:${TASK_C}`)).toContain("Своя версия.");
    expect(read(work, TASK_C)).toContain("status: Ready");
  });

  it.each([
    ["удалён в рабочей папке", false],
    ["удалён в индексе", true],
  ])("[SH-080 AC-4] файл задачи %s остаётся удалённым, перемотка проходит", (_name, staged) => {
    const repos = makeRepos();
    const { work } = repos;
    moveOriginMain(repos);
    if (staged) git(work, "rm", "-q", TASK_B);
    else rmSync(join(work, TASK_B));
    const before = git(work, "status", "--porcelain", "--", TASK_B);

    const { code } = runSync(work, "--apply");

    expect(code).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
    expect(existsSync(join(work, TASK_B))).toBe(false);
    expect(git(work, "status", "--porcelain", "--", TASK_B)).toBe(before);
  });
});

describe("pnpm sync: история не перематывается", () => {
  it("[SH-080 AC-5] при расходящейся истории не делает слияние и сообщает об этом", () => {
    const repos = makeRepos();
    const { work } = repos;
    writeFileSync(join(work, "README.md"), "локальный коммит\n");
    git(work, "commit", "-q", "-am", "local");
    moveOriginMain(repos);
    const headBefore = git(work, "rev-parse", "HEAD");

    const dry = runSync(work);
    const applied = runSync(work, "--apply");

    expect(dry.out).toMatch(/нельзя перемотать/);
    expect(applied.out).toMatch(/нельзя перемотать/);
    expect(applied.code).not.toBe(0);
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(work, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
  });
});
