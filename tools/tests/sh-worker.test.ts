import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-077: агент sh-worker, его хук и скрипты короткого вывода.
// AC-3 и AC-9 проверяются живым запуском агента, AC-10 — чтением документов;
// результаты записаны в заметках задачи.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "sh-worker-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function runNode(
  script: string,
  args: string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(process.execPath, [join(repoRoot, script), ...args], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  });
}

function frontmatter(path: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(read(path));
  if (!match?.[1]) throw new Error(`в ${path} нет frontmatter`);
  return YAML.parse(match[1]);
}

const toolList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim());

describe("[SH-077 AC-1] субагент sh-worker", () => {
  it("[SH-077 AC-1] tools без Skill и MCP, skills загружает sh-task", () => {
    const meta = frontmatter(".claude/agents/sh-worker.md");
    expect(meta.name).toBe("sh-worker");
    const tools = toolList(meta.tools);
    expect(tools).not.toContain("Skill");
    expect(tools.filter((tool) => tool.startsWith("mcp__"))).toEqual([]);
    for (const tool of tools) expect(["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Agent"]).toContain(tool);
    expect(meta.skills).toContain("sh-task");
    expect(existsSync(join(repoRoot, ".claude/skills/sh-task/SKILL.md"))).toBe(true);
    for (const field of ["model", "effort", "maxTurns", "autoCompactWindow"]) expect(meta).toHaveProperty(field);
  });

  it("[SH-077 AC-1] в .claude/settings.json нет ключа agent", () => {
    const path = join(repoRoot, ".claude/settings.json");
    const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    expect(settings).not.toHaveProperty("agent");
  });
});

describe("[SH-077 AC-2] хук sh-worker не даёт править backlog/", () => {
  const hook = "scripts/hooks/block-backlog-edit.mjs";
  const project = join(workDir, "project");
  mkdirSync(join(project, "backlog/tasks"), { recursive: true });
  writeFileSync(join(project, "backlog/config.yml"), 'project_name: "test"\n');

  const call = (tool: string, filePath: string) =>
    runNode(hook, [], {
      input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath }, cwd: project }),
    });

  it("[SH-077 AC-2] хук подключён к Edit и Write в frontmatter агента", () => {
    const meta = frontmatter(".claude/agents/sh-worker.md") as {
      hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] };
    };
    const entry = meta.hooks?.PreToolUse?.find((item) => item.hooks.some((h) => h.command.includes(hook)));
    expect(entry?.matcher.split("|").sort()).toEqual(["Edit", "Write"]);
  });

  it.each([
    ["Edit", "backlog/tasks/sh-001 - задача.md"],
    ["Write", "backlog/tasks/sh-002 - новая.md"],
    ["Edit", "backlog/config.yml"],
  ])("[SH-077 AC-2] %s файла %s блокируется с кодом 2", (tool, path) => {
    for (const filePath of [path, join(project, path)]) {
      const result = call(tool, filePath);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("backlog");
    }
  });

  it("хук блокирует вызов, если не смог разобрать вход", () => {
    const result = runNode(hook, [], { input: "не json" });
    expect(result.status).toBe(2);
  });

  it.each([
    ["Edit", "docs/process.md"],
    ["Write", "scripts/backlog-report.mjs"],
    ["Write", "notes/backlog/plan.md"],
  ])("[SH-077 AC-2] %s файла %s проходит с кодом 0", (tool, path) => {
    const result = call(tool, join(project, path));
    expect(result.status).toBe(0);
  });
});

const hasBacklogCli = spawnSync("backlog", ["--version"], { encoding: "utf8" }).status === 0;

describe("[SH-077 AC-4] scripts/task.mjs печатает задачу без дерева зависимостей", () => {
  const task = {
    id: "SH-900",
    title: "Пробная задача",
    status: "Ready",
    type: "chore",
    priority: "high",
    labels: ["infra"],
    milestone: "m-0",
    dependencies: ["SH-899"],
    dependencyGraph: { dependents: [{ id: "SH-901", title: "ДЕРЕВО-ЗАВИСИМЫХ" }] },
    description: "## Что нужно сделать\n1. ОПИСАНИЕ-ЗАДАЧИ",
    acceptanceCriteria: [{ index: 1, text: "КРИТЕРИЙ-ОДИН", checked: true }],
    definitionOfDone: [{ index: 1, text: "ПУНКТ-DOD", checked: false }],
    implementationPlan: "ПЛАН-РАБОТЫ",
    implementationNotes: "ЗАМЕТКИ-ХОДА",
    comments: [],
    finalSummary: "ИТОГ-ЗАДАЧИ",
  };

  it("[SH-077 AC-4] formatTask печатает описание, критерии, DoD, план, заметки и итог", async () => {
    const { formatTask } = await import("../../scripts/task.mjs");
    const text = formatTask(task);
    for (const part of ["SH-900", "Ready", "ОПИСАНИЕ-ЗАДАЧИ", "ПЛАН-РАБОТЫ", "ЗАМЕТКИ-ХОДА", "ИТОГ-ЗАДАЧИ", "SH-899"]) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(/\[x\] #1 КРИТЕРИЙ-ОДИН/);
    expect(text).toMatch(/\[ \] #1 ПУНКТ-DOD/);
    expect(text).not.toContain("ДЕРЕВО-ЗАВИСИМЫХ");
  });

  it.skipIf(!hasBacklogCli)("[SH-077 AC-4] для SH-005 вывод минимум вдвое короче backlog task view --plain", () => {
    const plain = execFileSync("backlog", ["task", "view", "SH-005", "--plain"], { cwd: repoRoot, encoding: "utf8" });
    const result = runNode("scripts/task.mjs", ["SH-005"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Drizzle и миграции");
    expect(result.stdout).toContain("pg_trgm");
    expect(result.stdout).not.toMatch(/Dependency Graph|Dependents/);
    expect(result.stdout.length * 2).toBeLessThanOrEqual(plain.length);
  });

  it.skipIf(!hasBacklogCli)("[SH-077 AC-4] на неизвестной задаче завершается с кодом не 0", () => {
    const result = runNode("scripts/task.mjs", ["SH-99999"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SH-99999");
  });
});

describe("[SH-077 AC-5] scripts/doc.mjs печатает один раздел документа", () => {
  it.each([
    ["td", "4.1", "### 4.1 Общие соглашения", "### 4.2"],
    ["technical-design", "§4.1", "### 4.1 Общие соглашения", "### 4.2"],
    ["use-cases", "UC-01", "### UC-01 Регистрация и первый вход", "### UC-02"],
    ["screens", "Э-01", "#### Э-01 Вход", "#### Э-02"],
  ])("[SH-077 AC-5] %s %s", (doc, section, heading, next) => {
    const result = runNode("scripts/doc.mjs", [doc, section]);
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith(heading)).toBe(true);
    expect(result.stdout).not.toContain(next);
  });

  it("[SH-077 AC-5] раздел верхнего уровня включает подразделы", () => {
    const result = runNode("scripts/doc.mjs", ["td", "4"]);
    expect(result.stdout).toContain("### 4.10");
    expect(result.stdout).not.toContain("## 5.");
  });

  it("[SH-077 AC-5] несуществующий раздел: код не 0 и список разделов", () => {
    const result = runNode("scripts/doc.mjs", ["td", "99.9"]);
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("99.9");
    expect(output).toContain("4.1 Общие соглашения");
    expect(output).toContain("5.2 Генерация уроков");
  });
});

describe("[SH-077 AC-6] pnpm verify печатает короткий итог", () => {
  it("[SH-077 AC-6] в package.json есть verify через scripts/verify.mjs", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.verify).toContain("scripts/verify.mjs");
  });

  const verify = (fixture: string) =>
    runNode("scripts/verify.mjs", ["--no-check", "--root", `tools/verify-fixtures/${fixture}`]);

  it("[SH-077 AC-6] зелёный прогон печатает не больше 20 строк", () => {
    const result = verify("passing");
    expect(result.status).toBe(0);
    const lines = (result.stdout + result.stderr).trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it("[SH-077 AC-6] при падении печатает имя упавшего теста и ошибку", () => {
    const result = verify("failing");
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("[fixture] упавший тест");
    expect(output).toContain("ожидаемая ошибка фикстуры");
    expect(output).not.toContain("✓ [fixture] зелёный тест");
  });
});

// Временный репозиторий с worktree: так тест видит то же, что новая сессия приложения.
function repoWithWorktree(name: string) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const main = join(workDir, name);
  const worktree = join(workDir, `${name}-wt`);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", worktree, "-b", "wt");
  return { main, worktree, env, git };
}

describe("[SH-077 AC-7] git status показывает кириллицу без восьмеричных кодов", () => {
  it("[SH-077 AC-7] postinstall запускает scripts/setup-git.mjs", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.postinstall).toContain("scripts/setup-git.mjs");
  });

  it("[SH-077 AC-7] в новом worktree после setup-git путь виден как есть", () => {
    const { worktree, env, git } = repoWithWorktree("quotepath");
    writeFileSync(join(worktree, "задача.md"), "x");
    expect(git(worktree, "status", "--porcelain")).not.toContain("задача.md");
    const result = runNode("scripts/setup-git.mjs", [], { cwd: worktree, env });
    expect(result.status).toBe(0);
    expect(git(worktree, "config", "core.quotepath").trim()).toBe("false");
    expect(git(worktree, "status", "--porcelain")).toContain("?? задача.md");
  });

  it("[SH-077 AC-7] вне git-репозитория setup-git не падает", () => {
    const dir = join(workDir, "no-git");
    mkdirSync(dir);
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: workDir };
    expect(runNode("scripts/setup-git.mjs", [], { cwd: dir, env }).status).toBe(0);
  });
});

describe("[SH-077 AC-8] сессия в новом worktree видит локальные переменные", () => {
  const hook = "scripts/hooks/session-env.mjs";

  it("[SH-077 AC-8] хук SessionStart подключён в .claude/settings.json", () => {
    const settings = JSON.parse(read(".claude/settings.json"));
    const commands = JSON.stringify(settings.hooks?.SessionStart ?? []);
    expect(commands).toContain(hook);
  });

  it("[SH-077 AC-8] переменные из .env основной папки попадают в CLAUDE_ENV_FILE", () => {
    const { main, worktree, env } = repoWithWorktree("session-env");
    writeFileSync(
      join(main, ".env"),
      "# локально\nPOSTGRES_PORT=5434\nDATABASE_URL=postgres://u:p@localhost:5434/db\n",
    );
    const envFile = join(workDir, "claude-env.sh");
    writeFileSync(envFile, "");
    const result = runNode(hook, [], {
      cwd: worktree,
      env: { ...env, CLAUDE_ENV_FILE: envFile },
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: worktree }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("5434");
    const seen = execFileSync("bash", ["-c", `source "${envFile}"; echo "$POSTGRES_PORT|$DATABASE_URL"`], {
      encoding: "utf8",
    });
    expect(seen.trim()).toBe("5434|postgres://u:p@localhost:5434/db");
  });

  it("[SH-077 AC-8] переменные не из списка разрешённых в CLAUDE_ENV_FILE не попадают", () => {
    const { main, worktree, env } = repoWithWorktree("session-env-allowed");
    writeFileSync(
      join(main, ".env"),
      "NODE_ENV=development\nS3_SECRET_ACCESS_KEY=секрет-фикстуры\nPOSTGRES_PASSWORD=пароль-фикстуры\nTEST_DATABASE_URL=postgres://u:p@localhost:5434/db_test\n",
    );
    const envFile = join(workDir, "claude-env-allowed.sh");
    writeFileSync(envFile, "");
    const result = runNode(hook, [], { cwd: worktree, env: { ...env, CLAUDE_ENV_FILE: envFile }, input: "{}" });
    expect(result.status).toBe(0);
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain("TEST_DATABASE_URL=");
    for (const name of [
      "NODE_ENV",
      "S3_SECRET_ACCESS_KEY",
      "POSTGRES_PASSWORD",
      "секрет-фикстуры",
      "пароль-фикстуры",
    ]) {
      expect(written).not.toContain(name);
    }
    expect(result.stdout + result.stderr).toBe("");
  });

  it("хук снимает кавычки, если после значения стоит комментарий", () => {
    const { main, worktree, env } = repoWithWorktree("session-env-quotes");
    writeFileSync(join(main, ".env"), 'POSTGRES_PORT="5434" # порт\nDATABASE_URL=postgres://u:p@h:5434/db # dev\n');
    const envFile = join(workDir, "claude-env-quotes.sh");
    writeFileSync(envFile, "");
    runNode(hook, [], { cwd: worktree, env: { ...env, CLAUDE_ENV_FILE: envFile }, input: "{}" });
    const seen = execFileSync("bash", ["-c", `source "${envFile}"; echo "$POSTGRES_PORT|$DATABASE_URL"`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(seen.trim()).toBe("5434|postgres://u:p@h:5434/db");
  });

  it("[SH-077 AC-8] без .env хук ничего не пишет и не падает", () => {
    const { worktree, env } = repoWithWorktree("session-env-empty");
    const envFile = join(workDir, "claude-env-empty.sh");
    writeFileSync(envFile, "");
    const result = runNode(hook, [], {
      cwd: worktree,
      env: { ...env, CLAUDE_ENV_FILE: envFile },
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: worktree }),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe("");
  });
});
