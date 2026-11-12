import { readFileSync } from "node:fs";
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

describe("[SH-082 AC-4] действия бывшего раздела описаны в docs/process.md", () => {
  const section = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    return text.slice(start, text.indexOf(to, start));
  };
  const process = read("docs/process.md");
  const lifecycle = section(process, "## 7. Жизненный цикл задачи", "## 8. Тесты");

  it("[SH-082 AC-4] команда Done с номерами пунктов DoD и сверка номеров с config", () => {
    expect(lifecycle).toContain("-s Done --check-dod 2 --check-dod 5 --check-dod 6");
    expect(lifecycle).toMatch(/сверя[а-я]+[^\n]*(config\.yml|task\.mjs)/);
  });

  it("[SH-082 AC-4] возврат в Review со снятием отметок и закрытие цикла", () => {
    expect(lifecycle).toContain("--uncheck-dod 2 --uncheck-dod 5 --uncheck-dod 6");
    expect(lifecycle).toContain("git switch --detach origin/main");
    expect(lifecycle).toContain("git branch -D");
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
