import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-090: агент sh-spec-critic, его режим хука и режим task.mjs --spec.
// AC-5, AC-6, AC-7 и AC-8 проверяются живым запуском агента, результаты записаны в заметках задачи;
// здесь для них проверено только, что порядок проверки и формат отчёта описаны в теле агента (AC-4).

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const AGENT = ".claude/agents/sh-spec-critic.md";
const VERIFIER = ".claude/agents/sh-verifier.md";
const HOOK = "scripts/hooks/verifier-bash-guard.mjs";

function agentFile(path = AGENT) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(path));
  if (!match?.[1]) throw new Error(`в ${path} нет frontmatter`);
  return { meta: YAML.parse(match[1]) as Record<string, unknown>, body: match[2] ?? "" };
}

const toolList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim()).filter(Boolean);

describe("[SH-090 AC-1] субагент sh-spec-critic", () => {
  it("[SH-090 AC-1] tools только Read, Bash, Grep, Glob, модель sonnet", () => {
    const { meta } = agentFile();
    expect(meta.name).toBe("sh-spec-critic");
    expect(meta.model).toBe("sonnet");
    expect(toolList(meta.tools).sort()).toEqual(["Bash", "Glob", "Grep", "Read"]);
  });

  it("[SH-090 AC-1] effort и maxTurns те же, что у sh-verifier", () => {
    const { meta } = agentFile();
    const verifier = agentFile(VERIFIER).meta;
    expect(meta.effort).toBeDefined();
    expect(meta.maxTurns).toBeDefined();
    expect(meta.effort).toBe(verifier.effort);
    expect(meta.maxTurns).toBe(verifier.maxTurns);
  });

  it("[SH-090 AC-1] хук Bash запускает verifier-bash-guard.mjs --mode spec-critic", () => {
    const { meta } = agentFile() as {
      meta: { hooks?: { PreToolUse?: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    };
    const entry = meta.hooks?.PreToolUse?.find((item) => item.hooks.some((h) => h.command.includes(HOOK)));
    expect(entry?.matcher).toBe("Bash");
    expect(entry?.hooks[0]?.type).toBe("command");
    expect(entry?.hooks[0]?.command).toContain("--mode spec-critic");
  });

  it("[SH-090 AC-1] агент не наследует скиллы", () => {
    expect(agentFile().meta).not.toHaveProperty("skills");
  });
});

describe("[SH-090 AC-2] node scripts/task.mjs SH-NNN --spec", () => {
  const task = {
    id: "SH-902",
    title: "Пробная спецификация",
    status: "Ready",
    type: "chore",
    priority: "medium",
    labels: ["infra", "docs"],
    milestone: "m-0",
    dependencies: ["SH-079"],
    references: ["docs/process.md"],
    description: [
      "## Что нужно сделать",
      "1. ОПИСАНИЕ-ЗАДАЧИ",
      "",
      "## План тестов",
      "| 1 | Юнит | ТЕСТ-ПЕРВОГО |",
    ].join("\n"),
    acceptanceCriteria: [
      { index: 1, text: "КРИТЕРИЙ-ОДИН", checked: false },
      { index: 2, text: "КРИТЕРИЙ-ДВА", checked: false },
    ],
    definitionOfDone: [{ index: 1, text: "ПУНКТ-DOD", checked: false }],
    implementationPlan: "ПЛАН-РАБОТЫ",
    implementationNotes: "ЗАМЕТКИ-ШТАБА",
    comments: [{ author: "штаб", content: "КОММЕНТАРИЙ-ШТАБА" }],
    finalSummary: "ИТОГ-ЗАДАЧИ",
  };
  const hidden = ["ПУНКТ-DOD", "ПЛАН-РАБОТЫ", "ЗАМЕТКИ-ШТАБА", "КОММЕНТАРИЙ-ШТАБА", "ИТОГ-ЗАДАЧИ"];

  it("[SH-090 AC-2] formatSpec печатает заголовок, описание и критерии", async () => {
    const { formatSpec } = await import("../../scripts/task.mjs");
    const text = formatSpec(task);
    expect(text).toContain("SH-902 Пробная спецификация");
    expect(text).toContain("Статус: Ready");
    expect(text).toContain("m-0");
    expect(text).toContain("infra, docs");
    expect(text).toContain("SH-079");
    expect(text).toContain("docs/process.md");
    expect(text).toContain("ОПИСАНИЕ-ЗАДАЧИ");
    expect(text).toContain("ТЕСТ-ПЕРВОГО");
    expect(text).toMatch(/\[ \] #1 КРИТЕРИЙ-ОДИН/);
    expect(text).toMatch(/\[ \] #2 КРИТЕРИЙ-ДВА/);
  });

  it("[SH-090 AC-2] в выводе formatSpec нет DoD, плана, заметок, комментариев и итога", async () => {
    const { formatSpec } = await import("../../scripts/task.mjs");
    const text = formatSpec(task);
    for (const part of hidden) expect(text).not.toContain(part);
    expect(text).not.toContain("Definition of Done");
  });

  // Настоящего backlog в CI нет: подставлен скрипт-заглушка с тем же ответом `task view --json`.
  it("[SH-090 AC-2] флаг --spec в scripts/task.mjs даёт заголовок, описание и критерии без остального", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-spec-critic-backlog-"));
    try {
      const stub = join(dir, "backlog");
      writeFileSync(
        stub,
        `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");\n` +
          `if (args !== "task view SH-902 --json") { console.error("неожиданные аргументы: " + args); process.exit(3); }\n` +
          `process.stdout.write(${JSON.stringify(JSON.stringify({ task }))});\n`,
      );
      chmodSync(stub, 0o755);
      const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [join(repoRoot, "scripts/task.mjs"), "SH-902", ...args], {
          encoding: "utf8",
          cwd: repoRoot,
          env,
        });

      const result = run("--spec");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SH-902 Пробная спецификация");
      expect(result.stdout).toContain("ОПИСАНИЕ-ЗАДАЧИ");
      expect(result.stdout).toMatch(/\[ \] #2 КРИТЕРИЙ-ДВА/);
      for (const part of hidden) expect(result.stdout).not.toContain(part);

      // Без флага печатается вся задача: заглушка подставлена и флаг что-то меняет.
      const full = run();
      expect(full.status).toBe(0);
      expect(full.stdout).toContain("ПЛАН-РАБОТЫ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[SH-090 AC-2] в агенте задача читается только через --spec", () => {
    const { body } = agentFile();
    expect(body).toContain("node scripts/task.mjs SH-NNN --spec");
    expect(body).not.toMatch(/backlog task view/);
  });
});

describe("[SH-090 AC-3] режим spec-critic хука пропускает чтение, task.mjs и doc.mjs", () => {
  const call = (command: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(repoRoot, HOOK), ...args], {
      encoding: "utf8",
      cwd: repoRoot,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repoRoot }),
    });
  const critic = (command: string) => call(command, "--mode", "spec-critic");

  it.each([
    "node scripts/task.mjs SH-090 --spec",
    "node scripts/task.mjs SH-079 --spec",
    "node scripts/doc.mjs td 4.2",
    "node scripts/doc.mjs uc UC-01",
    "node scripts/doc.mjs screens Э-01",
    "node scripts/doc.mjs process 4",
    "grep -rn 'cookie' docs",
    "grep -rn -i 'сессия' docs | head -n 20",
    "rg 'workspace_id' docs",
    "cat docs/product-concept.md",
    "ls docs/adr",
    "head -n 20 CLAUDE.md",
    "wc -l docs/technical-design.md",
    "find docs -name '*.md'",
    "git status --short",
    "git log --oneline -n 5",
    "git diff origin/main...HEAD --stat",
    "git show --stat HEAD",
    "git branch --show-current",
    "grep -rn 'AC-1' docs && node scripts/doc.mjs td 4.2",
  ])("[SH-090 AC-3] пропускает с кодом 0: %s", (command) => {
    const result = critic(command);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    "pnpm test",
    "pnpm ac:check",
    "pnpm spec:check SH-090",
    "pnpm verify",
    "pnpm exec vitest run",
    "pnpm exec vitest run tools/tests/sh-spec-critic.test.ts",
    "pnpm --filter @studhub/api test",
    "vitest run",
    "node scripts/check-ac-coverage.mjs",
    "node scripts/check-spec.mjs SH-090",
    "node scripts/sync.mjs",
    "node -e \"require('fs').writeFileSync('a','b')\"",
    "echo hi > file.txt",
    "echo hi >> file.txt",
    "cat docs/product-concept.md > copy.md",
    "git diff origin/main...HEAD > diff.patch",
    "cat <<EOF\nx\nEOF",
    "sed -i s/a/b/ docs/process.md",
    "tee out.txt",
    "rm -rf docs",
    "mv a b",
    "touch a",
    "git commit -m x",
    "git commit --allow-empty -m x",
    "git checkout main",
    "git switch main",
    "git reset --hard HEAD~1",
    "git add .",
    "git stash",
    "git merge main",
    "git rebase origin/main",
    "git push",
    "git branch new-branch",
    "git worktree add ../x",
    "backlog task edit SH-090 -s Done",
    "backlog task view SH-090",
    "backlog task create 'x'",
    "ls && git commit -m x",
    "ls | xargs rm",
    "echo $(rm file)",
    "",
  ])("[SH-090 AC-3] блокирует с кодом 2: %s", (command) => {
    const result = critic(command);
    expect(result.status).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("[SH-090 AC-3] текст блокировки называет sh-spec-critic, а не sh-verifier", () => {
    const result = critic("pnpm test");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("sh-spec-critic");
    expect(result.stderr).not.toContain("sh-verifier");
  });

  it("[SH-090 AC-3] без флага хук ведёт себя как раньше: тесты разрешены, текст называет sh-verifier", () => {
    expect(call("pnpm exec vitest run tools/tests/a.test.ts").status).toBe(0);
    expect(call("pnpm test").status).toBe(0);
    expect(call("node scripts/check-ac-coverage.mjs").status).toBe(0);
    const blocked = call("git commit -m x");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("sh-verifier");
    expect(blocked.stderr).not.toContain("sh-spec-critic");
  });

  it("[SH-090 AC-3] явный режим verifier равен режиму по умолчанию", () => {
    expect(call("pnpm test", "--mode", "verifier").status).toBe(0);
    expect(call("git commit -m x", "--mode", "verifier").status).toBe(2);
  });

  it("[SH-090 AC-3] неизвестный режим блокирует любой вызов", () => {
    for (const args of [["--mode", "other"], ["--mode"], ["--mode=spec-critic"]]) {
      const result = call("ls", ...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });

  it("[SH-090 AC-3] блокирует вызов, если не смог разобрать вход, и при внутреннем сбое", () => {
    const bad = spawnSync(process.execPath, [join(repoRoot, HOOK), "--mode", "spec-critic"], {
      encoding: "utf8",
      input: "не json",
    });
    expect(bad.status).toBe(2);
    const broken = spawnSync(
      process.execPath,
      [
        "--import",
        'data:text/javascript,String.prototype.trim=()=>{throw new Error("boom")}',
        join(repoRoot, HOOK),
        "--mode",
        "spec-critic",
      ],
      { encoding: "utf8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }) },
    );
    expect(broken.status).toBe(2);
  });

  it("[SH-090 AC-3] команда хука из frontmatter агента работает в режиме spec-critic", () => {
    const { meta } = agentFile() as unknown as {
      meta: { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    };
    const command = meta.hooks.PreToolUse[0]?.hooks[0]?.command;
    if (!command) throw new Error("в frontmatter нет команды хука");
    const run = (projectDir: string, bash: string) =>
      spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: bash } }),
      });
    expect(run(repoRoot, "node scripts/doc.mjs td 4.2").status).toBe(0);
    expect(run(repoRoot, "pnpm test").status).toBe(2);
    expect(run("", "ls").status).toBe(2);
  });
});

describe("[SH-090 AC-4] порядок проверки описан в теле агента", () => {
  it("[SH-090 AC-4] задача, зависимости, «Контекст», «Не входит», разделы документов и поиск grep", () => {
    const { body } = agentFile();
    for (const part of [
      "node scripts/task.mjs SH-NNN --spec",
      "зависимост",
      "«Контекст»",
      "«Не входит»",
      "node scripts/doc.mjs",
      "grep",
      "целиком не читай",
    ]) {
      expect(body).toContain(part);
    }
    expect(body).toMatch(/`backlog\/`/);
  });

  it("[SH-090 AC-4] виды проблем: непроверяемые критерии, противоречия, пропуски", () => {
    const { body } = agentFile();
    for (const part of [
      "субъективн",
      "наблюдаем",
      "уровень",
      "product-concept.md",
      "use-cases.md",
      "screens.md",
      "ADR",
    ]) {
      expect(body).toContain(part);
    }
    expect(body).toMatch(/главнее/);
    expect(body).toMatch(/пропуск/i);
  });

  it("[SH-090 AC-4] задача, которая сама меняет документ, даёт «замечание», а не «блокирует»", () => {
    const { body } = agentFile();
    expect(body).toMatch(/сама меняет/);
    expect(body).toMatch(/изменение решения/);
    expect(body).toContain("замечание");
  });

  it("[SH-090 AC-4] формат отчёта КРИТИКА SH-NNN и вердикты", () => {
    const { body } = agentFile();
    for (const part of [
      "КРИТИКА SH-NNN",
      "Прочитано:",
      "Непроверяемые критерии:",
      "Противоречия:",
      "Пропуски:",
      "Вердикт:",
      "можно в PR",
      "нужны правки",
      "блокирует",
      "замечаний",
    ]) {
      expect(body).toContain(part);
    }
    expect(body).toMatch(/40 строк/);
  });

  it("[SH-090 AC-4] запрет на изменения и на обход блокировки", () => {
    const { body } = agentFile();
    expect(body).toMatch(/Не меняй/);
    expect(body).toMatch(/не обходи/i);
    expect(body).toMatch(/чего не смог проверить/);
  });

  it("[SH-090 AC-4] вход: только ID задачи, один вызов на одну задачу", () => {
    const { body } = agentFile();
    expect(body).toContain("Проверь спецификацию SH-NNN");
    expect(body).toMatch(/одну задачу/);
  });
});

describe("[SH-090 AC-9] скилл sh-spec и документы описывают вызов sh-spec-critic", () => {
  it("[SH-090 AC-9] в SKILL.md шаг вызова критика после spec:check и повторный вызов после правок", () => {
    const text = read(".claude/skills/sh-spec/SKILL.md");
    const critic = text.indexOf("subagent_type: sh-spec-critic");
    expect(critic).toBeGreaterThan(-1);
    expect(text.indexOf("pnpm spec:check SH-NNN")).toBeLessThan(critic);
    expect(text).toMatch(/повторн/);
    expect(text).toContain("блокирует");
    expect(text).toMatch(/описани[а-я]* PR/);
    expect(text).toMatch(/непринят/);
    expect(critic).toBeLessThan(text.indexOf("Открой PR"));
  });

  it("[SH-090 AC-9] process.md: шаг 1 и подраздел про sh-spec-critic", () => {
    const text = read("docs/process.md");
    const step = /\n1\. \*\*Спецификация\.\*\*[^\n]*/.exec(text)?.[0] ?? "";
    expect(step).toContain("sh-spec-critic");
    expect(step.indexOf("spec:check")).toBeLessThan(step.indexOf("sh-spec-critic"));
    const start = text.indexOf("#### Проверка спецификации: sh-spec-critic");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(
      start,
      text.indexOf("\n#", start + 10) === -1 ? undefined : text.indexOf("\n#", start + 10),
    );
    for (const part of [
      ".claude/agents/sh-spec-critic.md",
      "Проверь спецификацию SH-NNN",
      "КРИТИКА SH-NNN",
      "--spec",
      "блокирует",
      "повторно",
      "описании PR",
      "непринят",
      "не заменяет",
      "не запускается в CI",
    ]) {
      expect(section).toContain(part);
    }
  });

  it("[SH-090 AC-9] CLAUDE.md: порядок в блоке штаба", () => {
    const text = read("CLAUDE.md");
    const at = text.indexOf("sh-spec-critic");
    expect(at).toBeGreaterThan(-1);
    const paragraph = text.slice(Math.max(0, at - 400), at + 900);
    expect(paragraph).toContain("spec:check");
    expect(paragraph).toMatch(/повторн/);
    expect(paragraph).toMatch(/описани[а-я]* PR/);
  });
});
