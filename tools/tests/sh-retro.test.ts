import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// Тесты SH-107 AC-39: агент sh-retro (deepseek-flash, только чтение, классификация причин
// и запись в docs/process-retro.md).

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const AGENT = ".claude/agents/sh-retro.md";

function agentFile() {
  if (!existsSync(join(repoRoot, AGENT))) return null;
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(AGENT));
  if (!match?.[1]) throw new Error(`в ${AGENT} нет frontmatter`);
  return { meta: YAML.parse(match[1]) as Record<string, unknown>, body: match[2] ?? "" };
}

const toolList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(",")).map((tool) => String(tool).trim()).filter(Boolean);

describe("[SH-107 AC-39] агент sh-retro", () => {
  it("[SH-107 AC-39] файл .claude/agents/sh-retro.md существует", () => {
    expect(existsSync(join(repoRoot, AGENT))).toBe(true);
  });

  it("[SH-107 AC-39] frontmatter: name sh-retro, модель deepseek-flash, только чтение", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.meta.name).toBe("sh-retro");
    const model = String(file.meta.model ?? "").toLowerCase();
    expect(model).toContain("deepseek");
    expect(model).toContain("flash");
    const tools = toolList(file.meta.tools);
    expect(tools.sort()).toEqual(["Bash", "Glob", "Grep", "Read"]);
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
  });

  it("[SH-107 AC-39] тело: вход — спецификация, замечания ревьюера, число кругов, вопросы воркера, причины остановок", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    for (const part of ["спецификация", "ревьюер", "кругов", "вопрос", "остановк"]) {
      expect(file.body, part).toContain(part);
    }
    expect(file.body).toContain("воркера");
  });

  it("[SH-107 AC-39] тело: классификация причин каждого «блокирует» и вопроса воркера", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.body).toContain("блокирует");
    expect(file.body).toContain("неоднозначн");
    expect(file.body).toContain("неполн");
    expect(file.body).toContain("код-правила");
    expect(file.body).toContain("баг воркера");
  });

  it("[SH-107 AC-39] тело: добавляет запись в docs/process-retro.md", () => {
    const file = agentFile();
    expect(file).not.toBeNull();
    if (!file) return;
    expect(file.body).toContain("docs/process-retro.md");
  });
});
