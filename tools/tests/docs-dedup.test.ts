import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Тесты SH-081. AC-2 (сверка шаблона брифа) и AC-4 (прогон CI на PR) ручные:
// результаты записаны в заметках задачи.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const commands = [
  { command: "pnpm sync", script: "scripts/sync.mjs" },
  { command: "pnpm status", script: "scripts/status.mjs" },
  { command: "pnpm git:prune", script: "scripts/git-prune.mjs" },
];

// Флаги берём из исходников: args.includes("--apply").
const flagsOf = (script: string) => [...read(script).matchAll(/includes\("(--[\w-]+)"\)/g)].map((match) => match[1]);

// Строки файла, где названа команда (после неё не идёт ещё слово команды: `pnpm status` не должно ловить чужое).
const mentions = (text: string, command: string) =>
  text
    .split("\n")
    .filter((line) => new RegExp(`${command.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}(?![\\w:-])`).test(line));

describe("[SH-081 AC-1] описание команд лежит в README", () => {
  it("[SH-081 AC-1] из исходников скриптов находятся флаги --apply и --delete", () => {
    expect(flagsOf("scripts/sync.mjs")).toEqual(["--apply"]);
    expect(flagsOf("scripts/git-prune.mjs")).toEqual(["--delete"]);
  });

  it.each(commands)("[SH-081 AC-1] README описывает $command и все её флаги", ({ command, script }) => {
    const readme = read("README.md");
    expect(readme).toContain(command);
    for (const flag of flagsOf(script)) expect(readme).toContain(`${command} ${flag}`);
  });

  it.each(["CLAUDE.md", "docs/process.md"])(
    "[SH-081 AC-1] %s упоминает каждую команду со ссылкой на README и без флагов",
    (file) => {
      const text = read(file);
      for (const { command, script } of commands) {
        const lines = mentions(text, command);
        expect(lines.length, `${file}: нет упоминания ${command}`).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line, `${file}: у ${command} нет ссылки на README`).toMatch(/README\.md/);
          for (const flag of flagsOf(script))
            expect(line, `${file}: ${command} описана с флагом ${flag}`).not.toContain(flag);
        }
      }
    },
  );

  it("[SH-081 AC-1] в docs/process.md нет описания git:prune списком под пунктом", () => {
    const lines = read("docs/process.md").split("\n");
    const at = lines.findIndex((line) => line.includes("pnpm git:prune"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1] ?? "").not.toMatch(/^\s+- /);
  });
});

describe("[SH-081 AC-3] pnpm/action-setup в CI", () => {
  const ci = read(".github/workflows/ci.yml");

  it("[SH-081 AC-3] в ci.yml нет pnpm/action-setup@v4", () => {
    expect(ci).not.toContain("pnpm/action-setup@v4");
  });

  it("[SH-081 AC-3] в ci.yml есть pnpm/action-setup@v6", () => {
    expect(ci).toContain("pnpm/action-setup@v6");
  });
});
