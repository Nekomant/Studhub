import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Тесты SH-081. AC-2 (сверка шаблона брифа) и AC-4 (прогон CI на PR) ручные:
// результаты записаны в заметках задачи.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

// sub — подкоманда, перед которой README описывает флаги: `pnpm factory run <флаг>`.
const commands: { command: string; script: string; sub?: string }[] = [
  { command: "pnpm sync", script: "scripts/sync.mjs" },
  { command: "pnpm status", script: "scripts/status.mjs" },
  { command: "pnpm git:prune", script: "scripts/git-prune.mjs" },
  { command: "pnpm factory", script: "scripts/factory.mjs", sub: "run" },
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

  it.each(commands)("[SH-081 AC-1] README описывает $command и все её флаги", ({ command, script, sub }) => {
    const readme = read("README.md");
    expect(readme).toContain(command);
    for (const flag of flagsOf(script)) expect(readme).toContain(`${command} ${sub ? `${sub} ` : ""}${flag}`);
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

  it("[SH-093 AC-14] README описывает pnpm factory run и pnpm factory run SH-NNN", () => {
    const readme = read("README.md");
    expect(readme).toContain("pnpm factory run");
    expect(readme).toContain("pnpm factory run SH-NNN");
    for (const flag of flagsOf("scripts/factory.mjs")) expect(readme).toContain(`pnpm factory run ${flag}`);
  });

  it("[SH-104 AC-23] README описывает pnpm factory list; флаги run к list не относятся", () => {
    expect(read("README.md")).toContain("pnpm factory list");
  });

  it("[SH-093 AC-14] docs/process.md и CLAUDE.md упоминают pnpm factory со ссылкой на README и без флагов", () => {
    for (const file of ["docs/process.md", "CLAUDE.md"]) {
      const lines = mentions(read(file), "pnpm factory");
      expect(lines.length, `${file}: нет упоминания pnpm factory`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${file}: у pnpm factory нет ссылки на README`).toMatch(/README\.md/);
        for (const flag of flagsOf("scripts/factory.mjs"))
          expect(line, `${file}: pnpm factory описана с флагом ${flag}`).not.toContain(flag);
      }
    }
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// SH-107. Переработка процесса исполнения задач (фабрика, воркер, ревьюер).
// ─────────────────────────────────────────────────────────────────────────────

// Срез документа от первого вхождения `from` до `to` (или до конца файла).
const section = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  if (start === -1) return "";
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end === -1 ? undefined : end);
};

describe("[SH-107 AC-4] тесты tools/tests/ не читают docs/ кроме process.md", () => {
  const testsDir = join(repoRoot, "tools/tests");
  const self = "docs-dedup.test.ts";

  // Нарушения в исходнике теста: import … from "docs/…" либо read/readFileSync
  // с путём-литералом docs/<файл>, отличным от docs/process.md.
  const docsReads = (src: string) => {
    const hits: string[] = [];
    for (const match of src.matchAll(/\bimport\s+[^"']*?\bfrom\s+["'][^"']*docs\/[^"']*["']/g)) {
      hits.push(`import из docs/: ${match[0].trim()}`);
    }
    for (const match of src.matchAll(/\b(?:readFileSync|read)\s*\(\s*[`'"]([^`'"]*docs\/[^`'"]*)[`'"]/g)) {
      const path = match[1];
      if (path !== "docs/process.md") hits.push(`читает ${path}`);
    }
    return hits;
  };

  it("[SH-107 AC-4] ни один tools/tests/*.test.ts (кроме этого файла) не читает docs/ кроме process.md", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(testsDir).sort()) {
      if (!file.endsWith(".test.ts") || file === self) continue;
      const src = readFileSync(join(testsDir, file), "utf8");
      for (const hit of docsReads(src)) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders, `чтение docs/ вне process.md:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("[SH-107 AC-36] документы описывают новый процесс без старых статусов", () => {
  const processDocs = ["docs/process.md", "CLAUDE.md", "README.md"];

  it.each(processDocs)("[SH-107 AC-36] %s упоминает команды фабрики", (file) => {
    const text = read(file);
    for (const cmd of ["factory ready", "factory next", "factory merge", "factory status"]) {
      expect(text, `${file}: нет команды «${cmd}»`).toContain(cmd);
    }
  });

  it.each(processDocs)("[SH-107 AC-36] %s упоминает статусы Backlog/Ready/Merged/Done", (file) => {
    const text = read(file);
    for (const status of ["Backlog", "Ready", "Merged", "Done"]) {
      expect(text, `${file}: нет статуса «${status}»`).toContain(status);
    }
  });

  it("[SH-107 AC-36] шаблон задачи §4 содержит поля «Права», «Затрагивает» и «Модель»", () => {
    const s4 = section(read("docs/process.md"), "## 4.", "## 5.");
    for (const field of ["Права", "Затрагивает", "Модель"]) {
      expect(s4, `§4: нет поля «${field}»`).toContain(field);
    }
  });

  it("[SH-107 AC-36] нет статусов In Progress и Review как текущих статусов задачи", () => {
    for (const file of ["docs/process.md", "CLAUDE.md"]) {
      const text = read(file);
      expect(text, `${file}: содержит «In Progress»`).not.toContain("In Progress");
      expect(text, `${file}: содержит «-s Review»`).not.toContain("-s Review");
      expect(text, `${file}: содержит «статус Review»`).not.toContain("статус Review");
    }
    expect(read("README.md"), "README: содержит close-task").not.toContain("close-task");
  });

  it("[SH-107 AC-36] нет обязательного вызова sh-verifier перед каждым PR", () => {
    const bad: string[] = [];
    for (const file of ["docs/process.md", "CLAUDE.md"]) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          // Обязательный вызов сейчас описан как шаг между ГОТОВО/проверкой и /code-review.
          if (line.includes("sh-verifier") && (line.includes("/code-review") || line.includes("code-review"))) {
            bad.push(`${file}:${i + 1} — sh-verifier перед code-review`);
          }
          if (line.includes("sh-verifier") && /обязательн/.test(line)) {
            bad.push(`${file}:${i + 1} — обязательный sh-verifier`);
          }
        });
    }
    expect(bad, `sh-verifier описан как обязательный:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("[SH-107 AC-37] документы нового процесса: ADR-0011, ADR-0010, ТД §12, удаление pipeline-requirements", () => {
  it("[SH-107 AC-37] есть ADR-0011 «Фабрика-оркестратор», ADR-0010 помечен заменённым", () => {
    const adr11 = readdirSync(join(repoRoot, "docs/adr")).find((f) => f.startsWith("0011-"));
    expect(adr11, "нет docs/adr/0011-*").toBeDefined();
    expect(read(`docs/adr/${adr11}`), "ADR-0011 без названия «Фабрика-оркестратор»").toMatch(/Фабрика-оркестратор/);

    expect(read("docs/adr/0010-factory.md"), "ADR-0010 не помечен заменённым").toMatch(/частично заменён|заменён/);
  });

  it("[SH-107 AC-37] ТД §12 описывает лёгкий/полный режим CI и шаг Done в deploy", () => {
    const s12 = section(read("docs/technical-design.md"), "## 12.", "## 13.");
    expect(s12, "§12: нет лёгкого режима CI").toMatch(/лёгк/);
    expect(s12, "§12: нет полного режима CI").toMatch(/полн(?:ый|ом|ого) режим/);
    expect(s12, "§12: нет шага Done в deploy").toMatch(/mark-done|Done/);
  });

  it("[SH-107 AC-37] pipeline-requirements.md удалён; tech-debt.md и process-retro.md есть", () => {
    expect(
      existsSync(join(repoRoot, "docs/pipeline-requirements.md")),
      "docs/pipeline-requirements.md должен быть удалён",
    ).toBe(false);
    expect(existsSync(join(repoRoot, "docs/adr/0010-factory.md")), "docs/adr/0010-factory.md должен существовать").toBe(
      true,
    );
    expect(existsSync(join(repoRoot, "docs/tech-debt.md")), "docs/tech-debt.md должен существовать").toBe(true);
    expect(existsSync(join(repoRoot, "docs/process-retro.md")), "docs/process-retro.md должен существовать").toBe(true);
  });

  it("[SH-104 AC-22] в ADR-0010 есть абзац, начинающийся «Пункт 2 дополняется:»", () => {
    expect(
      read("docs/adr/0010-factory.md")
        .split("\n")
        .some((line) => line.startsWith("Пункт 2 дополняется:")),
    ).toBe(true);
  });
});

describe("[SH-107 AC-30] файл docs/tech-debt.md с форматом записи", () => {
  it("[SH-107 AC-30] docs/tech-debt.md существует и описывает формат записи", () => {
    expect(existsSync(join(repoRoot, "docs/tech-debt.md")), "docs/tech-debt.md не существует").toBe(true);
    const text = read("docs/tech-debt.md");
    expect(text, "нет поля «источник»").toContain("источник");
    expect(text, "нет поля «статус»").toContain("статус");
    expect(text, "нет «что не так» или «проблема»").toMatch(/что не так|проблема/);
    expect(text, "нет «влияет» или «учесть»").toMatch(/влияет|учесть/);
  });
});

describe("[SH-107 AC-31] замечания перенесены в docs/tech-debt.md", () => {
  it("[SH-107 AC-31] remarks.mjs читает docs/tech-debt.md", () => {
    const src = readFileSync(join(repoRoot, "scripts/remarks.mjs"), "utf8");
    expect(src, "remarks.mjs не читает docs/tech-debt.md").toContain("docs/tech-debt.md");
  });

  it("[SH-107 AC-31] в карточках backlog/tasks/*.md нет строк «Замечание N:»", () => {
    const dir = join(repoRoot, "backlog/tasks");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^Замечание \d+:/.test(line.trim())) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders, `замечания остались в карточках:\n${offenders.join("\n")}`).toEqual([]);
  });
});
