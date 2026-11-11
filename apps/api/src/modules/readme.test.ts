import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "README.md"), "utf8");

// Все ts-блоки README для проверок примера.
const tsBlocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");

describe("README модулей", () => {
  it("[SH-005 AC-4] описывает соглашения ТД §4.1", () => {
    for (const term of ["uuidv7()", "workspace_id", "составн", "timestamptz", "bigint", "minor units", "CHECK"]) {
      expect(readme, term).toContain(term);
    }
  });

  it("[SH-005 AC-4] содержит пример таблицы арендатора в схеме Drizzle", () => {
    const example = tsBlocks.find((block) => block.includes("pgTable("));
    expect(example, "нет ts-блока с pgTable(").toBeDefined();
    expect(example).toContain("workspace_id");
    expect(example).toContain("uuidv7()");
    expect(example).toContain("references(");
    expect(example).toContain("timestamp(");
    expect(example).toContain("withTimezone: true");
    expect(example).toContain("bigint(");
    expect(example).toContain("CHECK");
  });
});
