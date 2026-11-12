import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Тесты SH-091: скрипт `scripts/close-task.mjs` (`pnpm close-task`).
// Каждый тест собирает во временной папке свой «GitHub» (bare-репозиторий), основную папку, второй клон,
// который двигает origin/main, и worktree ветки задачи. `gh` подменяется скриптом в PATH.
// ID задач в фикстурах из диапазона SH-9xx.

const script = resolve(import.meta.dirname, "../../scripts/close-task.mjs");
const repoRoot = resolve(import.meta.dirname, "../..");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "close-task-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const taskFile = (id: string, status: string) =>
  `---\nid: ${id}\ntitle: Задача ${id}\nstatus: ${status}\n---\n\nОписание.\n`;

const TASK_90 = "backlog/tasks/sh-90 - short.md";
const TASK_901 = "backlog/tasks/sh-901 - long.md";
const BRANCH = "sh-901-feat";

// Подставной gh: печатает JSON из файла или падает с сообщением. Аргументы вызова пишет в журнал.
const fakeBin = join(workDir, "bin");
const ghJson = join(workDir, "gh.json");
const ghLog = join(workDir, "gh.log");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, "gh"),
  `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ -n "$FAKE_GH_FAIL" ]; then printf '%s\\n' "$FAKE_GH_FAIL" >&2; exit 1; fi\ncat "${ghJson}"\n`,
);
chmodSync(join(fakeBin, "gh"), 0o755);

// PATH без gh: только обёртка над настоящим git.
const gitOnlyBin = join(workDir, "bin-git-only");
mkdirSync(gitOnlyBin, { recursive: true });
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(gitOnlyBin, "git"), `#!/bin/sh\nexec "${realGit}" "$@"\n`);
chmodSync(join(gitOnlyBin, "git"), 0o755);
symlinkSync(process.execPath, join(gitOnlyBin, "node"));

type Check = { status: string; conclusion: string | null };
const ok: Check = { status: "COMPLETED", conclusion: "SUCCESS" };

type Pr = { number: number; title: string; state: string; headRefName: string; statusCheckRollup: Check[] };
const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 31,
  title: "SH-901: Фича",
  state: "MERGED",
  headRefName: BRANCH,
  statusCheckRollup: [ok],
  ...over,
});

type Scenario = {
  base: string;
  origin: string;
  work: string;
  other: string;
  wt: string;
};

let counter = 0;

// Основная папка `work` отстаёт от origin/main на один «squash-коммит» со статусом задачи SH-901.
// Ветка sh-901-feat открыта в worktree `wt`, на GitHub она уже удалена. В основной папке файл SH-901 устарел (Ready).
function makeScenario({ originStatus = "Done", detached = false, withShortTask = true } = {}): Scenario {
  counter += 1;
  const base = join(workDir, `case-${counter}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  const other = join(base, "other");
  const wt = join(base, "wt");
  mkdirSync(base, { recursive: true });
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  mkdirSync(join(seed, "backlog/tasks"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "readme\n");
  if (withShortTask) writeFileSync(join(seed, TASK_90), taskFile("SH-90", "Ready"));
  writeFileSync(join(seed, TASK_901), taskFile("SH-901", "Ready"));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, work);
  git(base, "clone", "-q", origin, other);

  git(work, "worktree", "add", "-q", "-b", BRANCH, wt, "origin/main");
  writeFileSync(join(wt, "feature.txt"), "фича\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  git(wt, "push", "-q", "-u", "origin", BRANCH);

  writeFileSync(join(other, "feature.txt"), "фича\n");
  writeFileSync(join(other, TASK_901), taskFile("SH-901", originStatus));
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "SH-901: Фича (#31)");
  git(other, "push", "-q", "origin", "main");
  git(other, "push", "-q", "origin", "--delete", BRANCH);

  if (detached) {
    git(work, "fetch", "-q", "--all", "--prune");
    git(wt, "switch", "-q", "--detach", "origin/main");
  }
  return { base, origin, work, other, wt };
}

type RunOptions = { prs?: Pr[]; ghFail?: string; noGh?: boolean };

function runClose(cwd: string, args: string[], { prs = [pr()], ghFail, noGh = false }: RunOptions = {}) {
  writeFileSync(ghJson, JSON.stringify(prs));
  writeFileSync(ghLog, "");
  const path = noGh ? gitOnlyBin : `${fakeBin}:${process.env.PATH}`;
  const env = { ...process.env, PATH: path, FAKE_GH_FAIL: ghFail ?? "" };
  const result = spawnSync(noGh ? join(gitOnlyBin, "node") : process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  const out = `${result.stdout}${result.stderr}`;
  return { code: result.status, out, lines: out.trimEnd().split("\n"), ghCalls: readFileSync(ghLog, "utf8") };
}

const branches = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
const worktrees = (cwd: string) => git(cwd, "worktree", "list", "--porcelain");
const snapshot = (cwd: string) => ({
  head: git(cwd, "rev-parse", "HEAD"),
  branches: branches(cwd),
  worktrees: worktrees(cwd),
  status: git(cwd, "status", "--porcelain"),
});

const VERDICT = /^ЗАКРЫТЬ СЕССИЮ: (да|нет \(.+\))$/;
const lastLine = (lines: string[]) => lines[lines.length - 1];

describe("close-task: просмотр без --apply", () => {
  it("[SH-091 AC-1] без --apply ничего не меняет и печатает вердикт по трём проверкам", () => {
    const { work } = makeScenario();
    const before = snapshot(work);

    const { code, out, lines, ghCalls } = runClose(work, ["SH-901"]);

    expect(code).toBe(0);
    expect(snapshot(work)).toEqual(before);
    expect(out).toMatch(/PR #31.*слит/);
    expect(out).toMatch(/статус.*Done/i);
    expect(out).toMatch(/checks.*зелён/i);
    expect(lastLine(lines)).toBe("ЗАКРЫТЬ СЕССИЮ: да");
    expect(ghCalls).toContain("pr list");
    expect(ghCalls).toContain("--state all");
  });

  it("[SH-091 AC-1] в просмотре не удаляется ветка и не убирается worktree, даже если вердикт «да»", () => {
    const { work, wt } = makeScenario();

    const { code } = runClose(work, ["SH-901"]);

    expect(code).toBe(0);
    expect(branches(work)).toContain(BRANCH);
    expect(existsSync(join(wt, "feature.txt"))).toBe(true);
  });
});

describe("close-task: вердикт", () => {
  it("[SH-091 AC-2] слит, Done и checks SUCCESS, SKIPPED и NEUTRAL: «да», код 0", () => {
    const { work } = makeScenario();
    const checks: Check[] = [
      ok,
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "NEUTRAL" },
    ];

    const { code, lines } = runClose(work, ["SH-901"], { prs: [pr({ statusCheckRollup: checks })] });

    expect(code).toBe(0);
    expect(lastLine(lines)).toBe("ЗАКРЫТЬ СЕССИЮ: да");
  });

  it("[SH-091 AC-2] PR не слит: «нет» с причиной, код 1", () => {
    const { work } = makeScenario();

    const { code, lines } = runClose(work, ["SH-901"], { prs: [pr({ state: "OPEN" })] });

    expect(code).toBe(1);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*не слит.*\)$/);
  });

  it("[SH-091 AC-2] закрытый без слияния PR не считается слитым", () => {
    const { work } = makeScenario();

    const { code, lines } = runClose(work, ["SH-901"], { prs: [pr({ state: "CLOSED" })] });

    expect(code).toBe(1);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*не слит.*\)$/);
  });

  it("[SH-091 AC-2] в origin/main статус не Done: «нет» с причиной, код 1", () => {
    const { work } = makeScenario({ originStatus: "Review" });

    const { code, lines } = runClose(work, ["SH-901"]);

    expect(code).toBe(1);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*Review.*\)$/);
  });

  it.each([
    ["FAILURE", { status: "COMPLETED", conclusion: "FAILURE" }],
    ["ещё идёт", { status: "IN_PROGRESS", conclusion: null }],
  ])("[SH-091 AC-2] проверка PR %s: «нет» с причиной про checks, код 1", (_name, bad) => {
    const { work } = makeScenario();

    const { code, lines } = runClose(work, ["SH-901"], { prs: [pr({ statusCheckRollup: [ok, bad] })] });

    expect(code).toBe(1);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*checks.*\)$/i);
  });
});

describe("close-task: статус берётся из origin/main", () => {
  it("[SH-091 AC-3] в рабочей папке файл задачи Ready, в origin/main Done: статус Done", () => {
    const { work } = makeScenario();
    expect(readFileSync(join(work, TASK_901), "utf8")).toContain("status: Ready");

    const { code, out } = runClose(work, ["SH-901"]);

    expect(code).toBe(0);
    expect(out).toMatch(/Done/);
    expect(readFileSync(join(work, TASK_901), "utf8")).toContain("status: Ready");
  });

  it("[SH-091 AC-3] статус читается после git fetch: origin/main в клоне до запуска устарел", () => {
    const { work } = makeScenario();
    expect(git(work, "show", `origin/main:${TASK_901}`)).toContain("status: Ready");

    const { out } = runClose(work, ["SH-901"]);

    expect(out).toMatch(/Done/);
    expect(git(work, "show", `origin/main:${TASK_901}`)).toContain("status: Done");
  });

  it("[SH-091 AC-3] префикс SH-90 не совпадает с SH-901: у SH-90 статус Ready, а не Done", () => {
    const { work } = makeScenario();

    const { code, lines } = runClose(work, ["SH-90"], {
      prs: [pr({ number: 32, title: "SH-90: Короткая" })],
    });

    expect(code).toBe(1);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*Ready.*\)$/);
  });
});

describe("close-task: префикс номера задачи", () => {
  it("[SH-091 AC-3] файла SH-90 в origin/main нет, а SH-901 в Done: для SH-90 «задача не найдена», вердикт «нет»", () => {
    const { work } = makeScenario({ withShortTask: false });

    const { code, out, lines } = runClose(work, ["SH-90"], { prs: [pr({ number: 32, title: "SH-90: Короткая" })] });

    expect(code).toBe(1);
    expect(out).toMatch(/задача не найдена/);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*не найдена.*\)$/);
  });
});

describe("close-task: --apply", () => {
  it("[SH-091 AC-4] перематывает main, удаляет ветку с её SHA и чистый worktree", () => {
    const { work, wt } = makeScenario();
    const sha = git(work, "rev-parse", "--short", BRANCH);

    const { code, out, lines } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
    expect(git(work, "show", `HEAD:${TASK_901}`)).toContain("status: Done");
    expect(branches(work)).not.toContain(BRANCH);
    expect(out).toContain(sha);
    expect(existsSync(wt)).toBe(false);
    expect(worktrees(work)).not.toContain(wt);
    expect(lastLine(lines)).toBe("ЗАКРЫТЬ СЕССИЮ: да");
  });

  it("[SH-091 AC-4] worktree на отсоединённой голове после перехода на origin/main тоже убирается", () => {
    const { work, wt } = makeScenario({ detached: true });
    const sha = git(work, "rev-parse", "--short", BRANCH);

    const { code, out } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(branches(work)).not.toContain(BRANCH);
    expect(out).toContain(sha);
  });

  it("[SH-091 AC-4] удалённую ветку можно вернуть по напечатанному SHA", () => {
    const { work } = makeScenario();
    const full = git(work, "rev-parse", BRANCH);

    const { out } = runClose(work, ["SH-901", "--apply"]);

    const printed = /\b([0-9a-f]{7,40})\b/.exec(out.split("\n").find((line) => line.includes(BRANCH)) ?? "");
    expect(printed).not.toBeNull();
    expect(full.startsWith(printed?.[1] ?? "no")).toBe(true);
    git(work, "branch", "restored", printed?.[1] ?? "");
    expect(git(work, "rev-parse", "restored")).toBe(full);
  });
});

describe("close-task: что скрипт не трогает", () => {
  it("[SH-091 AC-5] worktree с незакоммиченным файлом остаётся и называется в выводе", () => {
    const { work, wt } = makeScenario();
    writeFileSync(join(wt, "scratch.txt"), "не потерять\n");

    const { code, out, lines } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(1);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
    expect(out).toContain(wt);
    expect(out).toMatch(/незакоммич/);
    expect(branches(work)).toContain(BRANCH);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.+\)$/);
  });

  it("[SH-091 AC-5] чужие ветки и чужие незакоммиченные файлы основной папки остаются на месте", () => {
    const { work } = makeScenario();
    git(work, "branch", "other-feature");
    writeFileSync(join(work, "README.md"), "моя правка\n");
    writeFileSync(join(work, "notes.txt"), "заметка\n");

    const { code } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(0);
    expect(branches(work)).toContain("other-feature");
    expect(branches(work)).toContain("main");
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("моя правка\n");
    expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("заметка\n");
  });

  it("[SH-091 AC-5] другой worktree на отсоединённой голове без следов ветки задачи не убирается", () => {
    const { work, base } = makeScenario();
    const stranger = join(base, "stranger");
    git(work, "worktree", "add", "-q", "--detach", stranger, "origin/main");

    const { code } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(0);
    expect(existsSync(stranger)).toBe(true);
  });

  it("[SH-091 AC-5] main нельзя перемотать: сообщает, код 1, ветка и worktree остаются", () => {
    const { work, wt } = makeScenario();
    writeFileSync(join(work, "local.txt"), "локальный коммит\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "local");
    const headBefore = git(work, "rev-parse", "HEAD");

    const { code, out, lines } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(1);
    expect(out).toMatch(/перемот/);
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore);
    expect(branches(work)).toContain(BRANCH);
    expect(existsSync(wt)).toBe(true);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*main.*\)$/);
  });

  it("[SH-091 AC-5] неотслеживаемый файл основной папки мешает перемотке: main не тронут, код 1", () => {
    const { work } = makeScenario();
    writeFileSync(join(work, "feature.txt"), "моя версия\n");
    const headBefore = git(work, "rev-parse", "HEAD");

    const { code, out } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(1);
    expect(out).toMatch(/перемот/);
    expect(git(work, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(join(work, "feature.txt"), "utf8")).toBe("моя версия\n");
  });

  it("[SH-091 AC-5] без слияния PR --apply не перематывает main и ничего не удаляет, код 1", () => {
    const { work, wt } = makeScenario();
    const before = snapshot(work);

    const { code, lines } = runClose(work, ["SH-901", "--apply"], { prs: [pr({ state: "OPEN" })] });

    expect(code).toBe(1);
    expect(snapshot(work)).toEqual(before);
    expect(existsSync(wt)).toBe(true);
    expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.*не слит.*\)$/);
  });
});

describe("close-task: нет данных для вердикта", () => {
  it.each([
    ["gh завершился с ошибкой", { ghFail: "gh: not logged in" }, /gh/],
    ["gh не установлен", { noGh: true }, /gh/],
    ["PR задачи не найден", { prs: [pr({ title: "SH-902: Другая задача" })] }, /не найден/],
    ["пустой список PR", { prs: [] }, /не найден/],
    [
      "найдено несколько PR",
      { prs: [pr(), pr({ number: 40, title: "SH-901: Повторный", state: "CLOSED" })] },
      /несколько/,
    ],
  ] satisfies [string, RunOptions, RegExp][])(
    "[SH-091 AC-6] %s: код 2, причина названа, ничего не изменено",
    (_name, options, reason) => {
      const { work, wt } = makeScenario();
      const before = snapshot(work);

      const { code, lines } = runClose(work, ["SH-901", "--apply"], options);

      expect(code).toBe(2);
      expect(lastLine(lines)).toMatch(/^ЗАКРЫТЬ СЕССИЮ: нет \(.+\)$/);
      expect(lastLine(lines)).toMatch(reason);
      expect(snapshot(work)).toEqual(before);
      expect(existsSync(wt)).toBe(true);
    },
  );

  it("[SH-091 AC-6] PR другой задачи с похожим номером не считается: SH-90 не находит PR SH-901", () => {
    const { work } = makeScenario();

    const { code, lines } = runClose(work, ["SH-90"]);

    expect(code).toBe(2);
    expect(lastLine(lines)).toMatch(/не найден/);
  });
});

describe("close-task: формат вывода", () => {
  const longError = Array.from({ length: 40 }, (_, i) => `строка ошибки ${i}`).join("\n");

  it.each([
    ["просмотр, «да»", ["SH-901"], {}],
    ["--apply, «да»", ["SH-901", "--apply"], {}],
    ["PR не слит", ["SH-901"], { prs: [pr({ state: "OPEN" })] }],
    ["gh упал с длинной ошибкой", ["SH-901"], { ghFail: longError }],
  ] satisfies [string, string[], RunOptions][])(
    "[SH-091 AC-7] %s: не больше 12 строк, последняя строка в формате вердикта",
    (_name, args, options) => {
      const { work } = makeScenario();

      const { lines } = runClose(work, args, options);

      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lastLine(lines)).toMatch(VERDICT);
    },
  );

  it("[SH-091 AC-7] много грязных worktree задачи не раздувают вывод больше 12 строк", () => {
    const { work, base } = makeScenario({ detached: true });
    for (let i = 0; i < 8; i += 1) {
      const path = join(base, `extra-${i}`);
      git(work, "worktree", "add", "-f", "-q", path, BRANCH);
      git(path, "switch", "-q", "--detach", "origin/main");
      writeFileSync(join(path, "dirty.txt"), "x\n");
    }

    const { code, lines } = runClose(work, ["SH-901", "--apply"]);

    expect(code).toBe(1);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lastLine(lines)).toMatch(VERDICT);
  });
});

describe("close-task: документы", () => {
  const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

  it("[SH-091 AC-8] README, process.md и CLAUDE.md описывают команду и порядок закрытия штабом", () => {
    expect(JSON.parse(read("package.json")).scripts["close-task"]).toBe("node scripts/close-task.mjs");
    expect(read("README.md")).toContain("pnpm close-task");
    expect(read("docs/process.md")).toContain("pnpm close-task SH-NNN --apply");
    expect(read("docs/process.md")).toContain("archive_session");
    expect(read("CLAUDE.md")).toContain("pnpm close-task SH-NNN --apply");
    expect(read("CLAUDE.md")).toContain("archive_session");
  });
});
