import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Тесты SH-082: сокращение набора плагинов и скиллов штаба.
// AC-2, AC-3 и AC-6 проверяются вручную замером /context в приложении; результаты в заметках задачи.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const DISABLED = [
  "one-shot-prompting@synced",
  "zizi-skills@synced",
  "design-skills@synced",
  "vectorlab-ux-skills@synced",
  "frontend-design@synced",
];

describe("[SH-082 AC-1] enabledPlugins в .claude/settings.json", () => {
  const settings = JSON.parse(read(".claude/settings.json")) as { enabledPlugins?: Record<string, boolean> };

  it("[SH-082 AC-1] пять плагинов отключены значением false", () => {
    for (const name of DISABLED) expect(settings.enabledPlugins?.[name], name).toBe(false);
  });

  it("[SH-082 AC-1] mattpocock-skills@synced не отключён", () => {
    expect(settings.enabledPlugins?.["mattpocock-skills@synced"]).not.toBe(false);
  });
});

describe("[SH-082 AC-4] скилл sh-task без раздела «Закрытие»", () => {
  const skill = read(".claude/skills/sh-task/SKILL.md");

  it("[SH-082 AC-4] раздела «Закрытие» нет", () => {
    expect(skill).not.toMatch(/^#+\s*Закрытие/m);
  });

  it("[SH-082 AC-4] есть ссылка на docs/process.md §7.1", () => {
    expect(skill).toMatch(/docs\/process\.md[^\n]*§7\.1/);
  });
});

describe("[SH-082 AC-5] документы про плагины и шаблон задачи", () => {
  it("[SH-082 AC-5] process.md описывает отключённые плагины и включение через settings.local.json", () => {
    const process = read("docs/process.md");
    for (const name of DISABLED) expect(process, name).toContain(name);
    expect(process).toContain(".claude/settings.local.json");
    expect(process).toContain('"<имя>@synced": true');
  });

  it("[SH-082 AC-5] CLAUDE.md указывает команды чтения шаблона и Definition of Ready", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toContain("node scripts/doc.mjs process 4");
    expect(claude).toContain("node scripts/doc.mjs process 5");
  });
});

describe("[SH-107 AC-29] скилл sh-code-rules", () => {
  const skillPath = ".claude/skills/sh-code-rules/SKILL.md";

  it("[SH-107 AC-29] скилл sh-code-rules существует", () => {
    expect(existsSync(join(repoRoot, skillPath))).toBe(true);
  });

  it("[SH-107 AC-29] содержит жёсткие правила кода из ТД §1, §13", () => {
    expect(existsSync(join(repoRoot, skillPath))).toBe(true);
    const skill = read(skillPath);
    for (const part of [
      "apps/api",
      "OpenAPI",
      "domain",
      "Hono",
      "Drizzle",
      "workspace_id",
      "ctx",
      "чужой кабинет",
      "404",
      "bigint",
      "minor units",
      "ISO 4217",
      "UTC",
      "зоне преподавателя",
      "ПДн",
      "product_event",
      "problem+json",
      "code",
      "Миграции",
      "вперёд",
    ]) {
      expect(skill, part).toContain(part);
    }
  });

  it("[SH-107 AC-29] CLAUDE.md не содержит самих правил, но ссылается на скилл", () => {
    const claude = read("CLAUDE.md");
    expect(claude).not.toMatch(/Каждая таблица арендатора содержит [`]?workspace_id[`]?/);
    expect(claude).not.toMatch(/Деньги — [`]?bigint[`]?/);
    expect(claude).toContain("sh-code-rules");
  });

  it("[SH-107 AC-29] sh-worker и sh-reviewer подключают скилл через skills:", () => {
    const worker = read(".claude/agents/sh-worker.md");
    expect(worker).toMatch(/skills:[\s\S]{0,200}sh-code-rules/);
    const reviewerPath = ".claude/agents/sh-reviewer.md";
    expect(existsSync(join(repoRoot, reviewerPath))).toBe(true);
    expect(read(reviewerPath)).toMatch(/skills:[\s\S]{0,200}sh-code-rules/);
  });
});
