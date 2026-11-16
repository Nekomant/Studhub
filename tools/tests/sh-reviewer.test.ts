import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-107 AC-28: агент sh-reviewer (deepseek-v4-pro уровня max, только чтение,
// скилл sh-code-rules, формат ответа: вердикт первой строкой и записи трёх типов).

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const AGENT = ".claude/agents/sh-reviewer.md";

function agentFile() {
  if (!existsSync(join(repoRoot, AGENT))) return null;
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(AGENT));
  if (!match?.[1]) throw new Error(`в ${AGENT} нет frontmatter`);
  return { meta: YAML.parse(match[1]) as Record<string, unknown>, body: match[2] ?? "" };
}

const toolList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim()).filter(Boolean);

describe("[SH-107 AC-28] агент sh-reviewer", () => {
  it("[SH-107 AC-28] файл .claude/agents/sh-reviewer.md существует", () => {
    expect(existsSync(join(repoRoot, AGENT))).toBe(true);
  });

  it("[SH-107 AC-28] frontmatter: name, модель deepseek-v4-pro уровня max, skills [sh-code-rules]", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.meta.name).toBe("sh-reviewer");
    const model = String(file.meta.model ?? "").toLowerCase();
    expect(model).toContain("deepseek");
    expect(model).toMatch(/pro|max/);
    // уровень max должен быть зафиксирован в frontmatter (поле модели или уровня).
    expect(JSON.stringify(file.meta).toLowerCase()).toContain("max");
    const skills = Array.isArray(file.meta.skills) ? file.meta.skills : [file.meta.skills];
    expect(skills).toContain("sh-code-rules");
  });

  it("[SH-107 AC-28] tools только чтение: Read, Grep, Glob, Bash; нет Edit/Write", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    const tools = toolList(file.meta.tools);
    expect(tools.sort()).toEqual(["Bash", "Glob", "Grep", "Read"]);
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
  });

  it("[SH-107 AC-28] тело: вердикт первой строкой и три типа записей", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.body).toMatch(/вердикт[^\n]*первой строкой|первой строкой[^\n]*вердикт/i);
    expect(file.body).toContain("блокирует");
    expect(file.body).toContain("замечание");
    expect(file.body).toContain("вопрос владельцу");
  });

  it("[SH-107 AC-28] тело: разрешённый Bash только для чтения", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    for (const cmd of ["git diff", "git log", "git show", "cat", "ls", "head", "tail", "wc"]) {
      expect(file.body, cmd).toContain(cmd);
    }
  });

  it("[SH-107 AC-28] тело: запреты Edit, Write, git commit, git push, git branch -d/-D, gh", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.body).toContain("Edit");
    expect(file.body).toContain("Write");
    expect(file.body).toContain("git commit");
    expect(file.body).toContain("git push");
    expect(file.body).toMatch(/git branch -[dD]/);
    expect(file.body).toMatch(/\bgh\b/);
  });
});
