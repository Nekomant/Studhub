import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-079: агент sh-verifier, его хук и режим task.mjs --criteria.
// AC-4 и AC-5 проверяются живым запуском агента, результаты записаны в заметках задачи;
// здесь для них проверено только, что порядок проверки и формат отчёта описаны в теле агента.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const AGENT = ".claude/agents/sh-verifier.md";
const HOOK = "scripts/hooks/verifier-bash-guard.mjs";

function agentFile() {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(AGENT));
  if (!match?.[1]) throw new Error(`в ${AGENT} нет frontmatter`);
  return { meta: YAML.parse(match[1]) as Record<string, unknown>, body: match[2] ?? "" };
}

const toolList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim()).filter(Boolean);

describe("[SH-079 AC-1] субагент sh-verifier", () => {
  it("[SH-079 AC-1] tools без Edit, Write, Skill, Agent и MCP, модель sonnet", () => {
    const { meta } = agentFile();
    expect(meta.name).toBe("sh-verifier");
    expect(meta.model).toBe("sonnet");
    const tools = toolList(meta.tools);
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash");
    for (const forbidden of ["Edit", "Write", "NotebookEdit", "Skill", "Agent", "Task"]) {
      expect(tools).not.toContain(forbidden);
    }
    expect(tools.filter((tool) => tool.startsWith("mcp__"))).toEqual([]);
    for (const tool of tools) expect(["Read", "Bash", "Grep", "Glob"]).toContain(tool);
  });

  it("[SH-079 AC-1] агент не наследует скиллы и не просит их загрузить", () => {
    const { meta } = agentFile();
    expect(meta).not.toHaveProperty("skills");
  });
});

describe("[SH-079 AC-2] node scripts/task.mjs --criteria", () => {
  const task = {
    id: "SH-901",
    title: "Пробная задача",
    status: "Review",
    description: [
      "## Что нужно сделать",
      "1. ОПИСАНИЕ-ЗАДАЧИ",
      "",
      "## План тестов",
      "| AC | Уровень | Тест |",
      "|---|---|---|",
      "| 1 | Юнит | ТЕСТ-ПЕРВОГО |",
      "| 2 | Ручная | ТЕСТ-ВТОРОГО |",
      "",
      "## Зачем",
      "ЗАЧЕМ-ЗАДАЧА",
    ].join("\n"),
    acceptanceCriteria: [
      { index: 1, text: "КРИТЕРИЙ-ОДИН", checked: true },
      { index: 2, text: "КРИТЕРИЙ-ДВА", checked: false },
    ],
    definitionOfDone: [{ index: 1, text: "ПУНКТ-DOD", checked: false }],
    implementationPlan: "ПЛАН-РАБОТЫ",
    implementationNotes: "ЗАМЕТКИ-ХОДА",
    comments: [],
    finalSummary: "ИТОГ-ЗАДАЧИ",
  };

  it("[SH-079 AC-2] formatCriteria печатает критерии и таблицу плана тестов", async () => {
    const { formatCriteria } = await import("../../scripts/task.mjs");
    const text = formatCriteria(task);
    expect(text).toMatch(/\[x\] #1 КРИТЕРИЙ-ОДИН/);
    expect(text).toMatch(/\[ \] #2 КРИТЕРИЙ-ДВА/);
    expect(text).toContain("План тестов");
    expect(text).toContain("| 1 | Юнит | ТЕСТ-ПЕРВОГО |");
    expect(text).toContain("| 2 | Ручная | ТЕСТ-ВТОРОГО |");
  });

  it("[SH-079 AC-2] в выводе нет описания, плана, заметок, DoD и итога", async () => {
    const { formatCriteria } = await import("../../scripts/task.mjs");
    const text = formatCriteria(task);
    for (const hidden of [
      "ОПИСАНИЕ-ЗАДАЧИ",
      "ЗАЧЕМ-ЗАДАЧА",
      "ПЛАН-РАБОТЫ",
      "ЗАМЕТКИ-ХОДА",
      "ИТОГ-ЗАДАЧИ",
      "ПУНКТ-DOD",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("[SH-079 AC-2] без таблицы плана тестов печатает критерии и пометку об отсутствии таблицы", async () => {
    const { formatCriteria } = await import("../../scripts/task.mjs");
    const text = formatCriteria({ ...task, description: "## Что нужно сделать\n1. ОПИСАНИЕ-ЗАДАЧИ" });
    expect(text).toContain("КРИТЕРИЙ-ОДИН");
    expect(text).toContain("План тестов");
    expect(text).toMatch(/нет таблицы/i);
    expect(text).not.toContain("ОПИСАНИЕ-ЗАДАЧИ");
  });

  // Настоящего backlog в CI нет, поэтому вместо него подставлен скрипт-заглушка с тем же ответом `task view --json`.
  // Тест всегда выполняется и проходит весь путь scripts/task.mjs: разбор аргументов, вызов backlog, вывод.
  it("[SH-079 AC-2] флаг --criteria в scripts/task.mjs даёт только критерии и план тестов", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-verifier-backlog-"));
    try {
      const stub = join(dir, "backlog");
      writeFileSync(
        stub,
        `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");\n` +
          `if (args !== "task view SH-901 --json") { console.error("неожиданные аргументы: " + args); process.exit(3); }\n` +
          `process.stdout.write(${JSON.stringify(JSON.stringify({ task }))});\n`,
      );
      chmodSync(stub, 0o755);
      const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [join(repoRoot, "scripts/task.mjs"), "SH-901", ...args], {
          encoding: "utf8",
          cwd: repoRoot,
          env,
        });

      const result = run("--criteria");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\[x\] #1 КРИТЕРИЙ-ОДИН/);
      expect(result.stdout).toContain("| AC | Уровень | Тест |");
      expect(result.stdout).toContain("| 2 | Ручная | ТЕСТ-ВТОРОГО |");
      for (const hidden of [
        "ОПИСАНИЕ-ЗАДАЧИ",
        "ЗАЧЕМ-ЗАДАЧА",
        "ПЛАН-РАБОТЫ",
        "ЗАМЕТКИ-ХОДА",
        "ИТОГ-ЗАДАЧИ",
        "ПУНКТ-DOD",
      ]) {
        expect(result.stdout).not.toContain(hidden);
      }

      // Без флага печатается вся задача: заглушка действительно подставлена и флаг что-то меняет.
      const full = run();
      expect(full.status).toBe(0);
      expect(full.stdout).toContain("ОПИСАНИЕ-ЗАДАЧИ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[SH-079 AC-2] в агенте задача читается только через --criteria", () => {
    const { body } = agentFile();
    expect(body).toContain("node scripts/task.mjs SH-NNN --criteria");
    expect(body).not.toMatch(/backlog task view/);
  });
});

describe("[SH-079 AC-3] хук sh-verifier пропускает только чтение и запуск тестов", () => {
  const call = (command: string) =>
    spawnSync(process.execPath, [join(repoRoot, HOOK)], {
      encoding: "utf8",
      cwd: repoRoot,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repoRoot }),
    });

  it("[SH-079 AC-3] хук подключён к Bash в frontmatter агента", () => {
    const { meta } = agentFile() as {
      meta: { hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] } };
    };
    const entry = meta.hooks?.PreToolUse?.find((item) => item.hooks.some((h) => h.command.includes(HOOK)));
    expect(entry?.matcher).toBe("Bash");
  });

  it.each([
    "git commit -m x",
    "git commit --allow-empty -m x",
    "git checkout main",
    "git checkout -- tools/tests/a.test.ts",
    "git switch other",
    "git reset --hard HEAD~1",
    "git restore tools/tests/a.test.ts",
    "git add .",
    "git stash",
    "git merge main",
    "git rebase origin/main",
    "git push",
    "git fetch origin",
    "git pull",
    "git clean -fd",
    "git tag v1",
    "git branch new-branch",
    "git branch -D old",
    "git worktree add ../x",
    "git apply patch.diff",
    "git diff --output=out.txt",
    "git -C /tmp commit -m x",
    "rm -rf tools",
    "rm file",
    "mv a b",
    "cp a b",
    "touch a",
    "mkdir a",
    "chmod +x a",
    "echo hi > file.txt",
    "echo hi >> file.txt",
    "cat a.txt > b.txt",
    "git diff origin/main...HEAD > diff.patch",
    "cat <<EOF\nx\nEOF",
    "sed -i s/a/b/ file",
    "sed --in-place s/a/b/ file",
    "sed 'w out.txt' package.json",
    "sed -n 'w out.txt' package.json",
    "sed 's/a/b/w out.txt' package.json",
    "sed -n 's/a/b/gpw out.txt' package.json",
    "sed '1,3w out.txt' package.json",
    "sed '/x/w out.txt' package.json",
    "sed 'W out.txt' package.json",
    "sed 's/a/b/e' package.json",
    "sed 's/a/b/ge' package.json",
    "sed '1e touch x' package.json",
    "sed e package.json",
    "sed -e 'w out.txt' package.json",
    "sed -n -e p -e 'w out.txt' package.json",
    "sed --expression='w out.txt' package.json",
    "sed --expression 'w out.txt' package.json",
    "sed -ne 'w out.txt' package.json",
    "sed -f script.sed package.json",
    "sed --file=script.sed package.json",
    "sed -n 'p;w out.txt' package.json",
    "sed 'p\nw out.txt' package.json",
    "sed -n '/a/,/b/{p;w out.txt}' package.json",
    "sed 'r other.txt' package.json",
    "sed 'a text' package.json",
    "sed",
    "sed -n",
    "rg --pre ./evil.sh x .",
    "rg --pre=./evil.sh x .",
    "rg --pre-glob '*.ts' --pre cat x .",
    "rg --pre-glob=*.ts x .",
    "rg --hostname-bin ./evil x .",
    "sort --compress-program=./evil package.json",
    "uniq in.txt out.txt",
    "date -s 2020-01-01",
    "tee out.txt",
    "git diff | tee out.txt",
    "sort -o out.txt in.txt",
    "find . -name '*.ts' -delete",
    "find . -name '*.ts' -exec rm {} ;",
    "pnpm install",
    "pnpm add left-pad",
    "pnpm exec vitest run -u",
    "pnpm exec vitest run --update",
    "pnpm exec vitest",
    "pnpm exec vitest tools/tests/a.test.ts",
    "pnpm exec vitest watch",
    "pnpm exec vitest --run tools/tests/a.test.ts",
    "pnpm exec vitest --reporter=minimal run tools/tests/a.test.ts",
    "pnpm exec vitest run --outputFile=out.json",
    "pnpm exec vitest run --outputFile out.json",
    "pnpm exec vitest run --reporter=json --outputFile.json=out.json",
    "pnpm exec vitest run --output=out",
    "pnpm test --outputFile=out.json",
    "pnpm test --outputFile out.json",
    "pnpm test --output-file=out.json",
    "pnpm ac:check --outputFile=out.json",
    "pnpm ac:check --output=out.txt",
    "pnpm test -u",
    "pnpm ac:check --update",
    "pnpm exec biome check --write .",
    "pnpm format",
    "node -e \"require('fs').writeFileSync('a','b')\"",
    "node scripts/sync.mjs",
    "node some-script.mjs",
    "curl https://example.com",
    "npx something",
    "python3 -c 'print(1)'",
    "bash -c 'rm a'",
    "sh -c 'rm a'",
    "backlog task edit SH-079 -s Done",
    "ls && rm file",
    "git status; git commit -m x",
    "git status || rm file",
    "git log | xargs rm",
    "echo $(rm file)",
    "echo `rm file`",
    "ls <(rm file)",
    "FOO=1 rm file",
    "FOO=1 git status",
    "GIT_EXTERNAL_DIFF='touch x' git diff origin/main...HEAD",
    "GIT_EXTERNAL_DIFF=./evil git diff",
    "GIT_PAGER='sh -c x' git log",
    "GIT_CONFIG_COUNT=1 git status",
    "BASH_ENV=./x.sh bash -c true",
    "BASH_ENV=./x.sh ls",
    "LD_PRELOAD=./x.so ls",
    "NODE_OPTIONS=--require=./x.js node scripts/doc.mjs td",
    "PATH=./bin:$PATH ls",
    "CI=1 FOO=1 git status",
    "CI=1 GIT_PAGER=x git log",
    "cd .. && git commit -m x",
    "ls & rm file",
    "ls\nrm file",
    "",
  ])("[SH-079 AC-3] блокирует с кодом 2: %s", (command) => {
    const result = call(command);
    expect(result.status).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it.each([
    "git diff origin/main...HEAD",
    "git diff origin/main...HEAD --stat",
    "git diff origin/main...HEAD -- backlog/tasks | head -n 50",
    "git diff abc123 HEAD -- tools/tests/a.test.ts",
    "git log --oneline origin/main..HEAD",
    "git log --format=%H --grep='test(.*): SH-079 тесты' origin/main..HEAD",
    "git show abc123:tools/tests/a.test.ts",
    "git show --stat HEAD",
    "git status --short",
    "git branch --show-current",
    "git branch --list",
    "git rev-parse HEAD",
    "git merge-base origin/main HEAD",
    "git ls-files tools",
    "git grep -n 'SH-079 AC-1' HEAD -- tools",
    "git cat-file -p HEAD",
    "git blame -L 1,5 README.md",
    "git worktree list",
    "cat tools/tests/sh-verifier.test.ts",
    "head -n 20 package.json",
    "tail -n 20 package.json",
    "ls -la tools/tests",
    "grep -rn '\\[SH-079 AC-1\\]' tools",
    "grep -n 'a > b' package.json",
    "rg 'SH-079' tools",
    "wc -l package.json",
    "find tools -name '*.test.ts'",
    "sed -n '1,20p' package.json",
    "sed -n 1,20p package.json",
    "sed -n '$p' package.json",
    "sed -n '/foo/p' package.json",
    "sed -n '/foo/,/bar/p' package.json",
    "sed -n '/foo/I,+3p' package.json",
    "sed -n -e '1p' -e '5p' package.json",
    "sed -ne '1,3p' package.json",
    "sed --quiet --expression='2p' package.json",
    "sed 's/a/b/' package.json",
    "sed 's/a/b/gp' package.json",
    "sed 's|a|b|g' package.json",
    "sed -E 's/(a)+/b/' package.json",
    "sed 's/new\\/world/old/' package.json",
    "sed 's/write/exec/' package.json",
    "sed '1!d' package.json",
    "sed 5q package.json",
    "sed '/^$/d' package.json",
    "sed 'y/abc/xyz/' package.json",
    "sed -n 'p;p' package.json",
    "rg -n 'pre' tools",
    "date +%s",
    "date -u",
    "uniq -c package.json",
    "sort package.json | uniq | wc -l",
    "diff a.txt b.txt",
    "echo 'проверка'",
    "pwd",
    "cd tools && ls",
    "node scripts/task.mjs SH-079 --criteria",
    "node scripts/doc.mjs td 4.1",
    "node scripts/check-ac-coverage.mjs",
    "pnpm test",
    "pnpm ac:check",
    "pnpm exec vitest run tools/tests/sh-verifier.test.ts",
    "pnpm exec vitest run --reporter=minimal tools/tests/sh-verifier.test.ts tools/tests/other.test.ts",
    "pnpm --filter @studhub/api test",
    "grep -n foo package.json 2>&1",
    "ls missing 2>/dev/null",
    "ls missing > /dev/null 2>&1",
    "git status --short && git log --oneline -n 3",
    "git status --short; git log --oneline -n 3",
    "CI=1 git status",
    "NO_COLOR=1 LANG=C git status --short",
  ])("[SH-079 AC-3] пропускает с кодом 0: %s", (command) => {
    const result = call(command);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("[SH-079 AC-3] блокирует вызов, если не смог разобрать вход", () => {
    const result = spawnSync(process.execPath, [join(repoRoot, HOOK)], { encoding: "utf8", input: "не json" });
    expect(result.status).toBe(2);
  });

  it("[SH-079 AC-3] блокирует вызов при внутреннем сбое хука", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", 'data:text/javascript,String.prototype.trim=()=>{throw new Error("boom")}', join(repoRoot, HOOK)],
      { encoding: "utf8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }) },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("упал");
  });

  it("[SH-079 AC-3] блокирует вызов, если во входе нет объекта", () => {
    for (const input of ["null", "[]", "42", '"ls"']) {
      const result = spawnSync(process.execPath, [join(repoRoot, HOOK)], { encoding: "utf8", input });
      expect(result.status, input).toBe(2);
    }
  });

  describe("команда хука из frontmatter агента", () => {
    const hookCommand = () => {
      const { meta } = agentFile() as unknown as {
        meta: { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
      };
      const command = meta.hooks.PreToolUse[0]?.hooks[0]?.command;
      if (!command) throw new Error("в frontmatter нет команды хука");
      return command;
    };
    const run = (projectDir: string, command: string) =>
      spawnSync("sh", ["-c", hookCommand()], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      });

    it("[SH-079 AC-3] без скрипта хука в $CLAUDE_PROJECT_DIR итог 2", () => {
      const empty = mkdtempSync(join(tmpdir(), "sh-verifier-noscript-"));
      try {
        expect(run(empty, "ls").status).toBe(2);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("[SH-079 AC-3] без $CLAUDE_PROJECT_DIR итог 2", () => {
      expect(run("", "ls").status).toBe(2);
    });

    it("[SH-079 AC-3] со скриптом: чтение пропущено, запись заблокирована", () => {
      expect(run(repoRoot, "git status --short").status).toBe(0);
      expect(run(repoRoot, "git commit -m x").status).toBe(2);
    });
  });

  it("[SH-079 AC-3] блокирует Bash без поля command", () => {
    const result = spawnSync(process.execPath, [join(repoRoot, HOOK)], {
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    });
    expect(result.status).toBe(2);
  });
});

describe("[SH-079 AC-4] порядок проверки описан в теле агента", () => {
  it("[SH-079 AC-4] дифф ветки, коммит красных тестов, метки AC и запуск тестов", () => {
    const { body } = agentFile();
    for (const part of [
      "git diff origin/main...HEAD",
      "тесты по критериям приёмки",
      "[SH-NNN AC-n]",
      "подтверждён",
      "сомнительно",
      "не подтверждён",
      "ПРОВЕРКА SH-NNN",
    ]) {
      expect(body).toContain(part);
    }
    expect(body).toMatch(/vitest/);
  });

  it("[SH-079 AC-4] критерии с уровнем Ручная, Ревью и Скрипт перечисляются как непроверенные", () => {
    const { body } = agentFile();
    for (const level of ["Ручная", "Ревью", "Скрипт"]) expect(body).toContain(level);
    expect(body).toMatch(/непроверенн/);
  });

  it("[SH-079 AC-4] агент не меняет рабочее дерево и HEAD", () => {
    const { body } = agentFile();
    expect(body).toMatch(/не меняй/i);
  });
});

describe("[SH-079 AC-5] проверка подмены теста описана в теле агента", () => {
  it("[SH-079 AC-5] сравнение теста в коммите красных тестов и в HEAD, нарушение правила", () => {
    const { body } = agentFile();
    expect(body).toContain("менять тест под код");
    expect(body).toMatch(/красных тестов/);
    expect(body).toMatch(/ослаблен/);
    expect(body).toMatch(/нарушени/i);
  });
});

describe("[SH-079 AC-6] документы описывают вызов sh-verifier", () => {
  const section = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start + from.length);
    if (start === -1) throw new Error(`нет «${from}»`);
    return text.slice(start, end === -1 ? undefined : end);
  };

  it("[SH-079 AC-6] §7.1 process.md: вызов после ГОТОВО и до /code-review, замечания sh-worker, повторная проверка", () => {
    const text = section(read("docs/process.md"), "### 7.1", "\n## 8");
    expect(text).toContain("sh-verifier");
    expect(text).toContain("sh-verifier.md");
    const step = text.slice(text.search(/\n5\. /));
    const verifierAt = step.indexOf("sh-verifier");
    expect(verifierAt).toBeGreaterThan(-1);
    expect(step.indexOf("ГОТОВО SH-NNN")).toBeLessThan(verifierAt);
    expect(verifierAt).toBeLessThan(step.indexOf("/code-review"));
    expect(step).toMatch(/sh-worker|агенту/);
    expect(step).toMatch(/повтор/i);
    expect(step).toMatch(/заметк/);
  });

  it("[SH-079 AC-6] CLAUDE.md упоминает sh-verifier, повторную проверку и порядок перед /code-review", () => {
    const text = read("CLAUDE.md");
    const at = text.indexOf("sh-verifier");
    expect(at).toBeGreaterThan(-1);
    const paragraph = text.slice(at - 600, at + 900);
    expect(paragraph).toContain("/code-review");
    expect(paragraph).toMatch(/повтор/i);
  });
});
