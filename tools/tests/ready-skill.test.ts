import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Тесты SH-104. AC-13–AC-16 ручные (запуск /ready в приложении), AC-17, AC-19 и AC-24 проверяет ревью.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const skill = read(".claude/skills/ready/SKILL.md");

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("нет frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

// Текст от заголовка, начинающегося с `from`, до следующего заголовка, начинающегося с `to`.
function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`нет раздела ${from}`);
  return text.slice(start, end);
}

const process7 = () => {
  const text = read("docs/process.md");
  return section(text, "## 7. Жизненный цикл задачи", "### 7.1 ");
};
const process71 = () => {
  const text = read("docs/process.md");
  return section(text, "### 7.1 ", "## 8. Тесты");
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const SENTENCE =
  "В приложении задачу стартует /ready, из терминала pnpm factory run; штаб с sh-worker остаётся запасным способом.";
const DIRECT = "/ready — прямая команда владельца";

describe("[SH-104] скилл ready", () => {
  it("[SH-104 AC-10] во frontmatter name: ready, description и disable-model-invocation: true, нет hooks и model", () => {
    const fields = frontmatter(skill);

    expect(fields.name).toBe("ready");
    expect(fields.description?.length).toBeGreaterThan(0);
    expect(fields["disable-model-invocation"]).toBe("true");
    expect(fields).not.toHaveProperty("hooks");
    expect(fields).not.toHaveProperty("model");
  });

  it("[SH-104 AC-11] каталога .claude/commands нет", () => {
    expect(existsSync(join(repoRoot, ".claude/commands"))).toBe(false);
  });

  it("[SH-104 AC-11] pnpm factory run в .claude/skills упомянут только в ready/SKILL.md", () => {
    const dir = join(repoRoot, ".claude/skills");
    const withRun = filesUnder(dir)
      .filter((file) => readFileSync(file, "utf8").includes("pnpm factory run"))
      .map((file) => file.slice(dir.length + 1));

    expect(withRun).toEqual(["ready/SKILL.md"]);
  });

  it("[SH-104 AC-12] .claude/settings.json не содержит /ready и pnpm factory", () => {
    const settings = read(".claude/settings.json");

    expect(settings).not.toContain("/ready");
    expect(settings).not.toContain("pnpm factory");
  });

  it("[SH-104 AC-18] в SKILL.md нет --foreground", () => {
    expect(skill).not.toContain("--foreground");
  });
});

describe("[SH-104] документы", () => {
  it("[SH-104 AC-20] предложение про /ready есть в docs/process.md §7 и §7.1", () => {
    expect(process7()).toContain(SENTENCE);
    expect(process71()).toContain(SENTENCE);
  });

  it("[SH-104 AC-21] «/ready — прямая команда владельца» есть в process.md §7, ADR-0010 п. 4 и CLAUDE.md", () => {
    expect(process7()).toContain(DIRECT);
    const adr = read("docs/adr/0010-factory.md");
    const item4 = adr.split("\n").find((line) => line.startsWith("4. "));
    expect(item4).toContain(DIRECT);
    expect(read("CLAUDE.md")).toContain(DIRECT);
  });

  it("[SH-104 AC-22] в ADR-0010 есть абзац, начинающийся «Пункт 2 дополняется:»", () => {
    const adr = read("docs/adr/0010-factory.md");

    expect(adr.split("\n").some((line) => line.startsWith("Пункт 2 дополняется:"))).toBe(true);
  });

  it("[SH-104 AC-23] README описывает /ready и pnpm factory list", () => {
    const readme = read("README.md");

    expect(readme).toContain("/ready");
    expect(readme).toContain("pnpm factory list");
  });
});
