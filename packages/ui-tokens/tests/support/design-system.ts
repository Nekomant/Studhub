// Разбор таблиц docs/design-system.md: тесты сверяют CSS с документом, а не с копией значений.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./paths.ts";

const doc = readFileSync(resolve(repoRoot, "docs/design-system.md"), "utf8");

/** Текст раздела `## N. …` до следующего `## `. */
function section(number: number): string {
  const start = doc.indexOf(`\n## ${number}. `);
  if (start === -1) throw new Error(`В design-system.md нет раздела ${number}`);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

/** Строки таблицы раздела: ячейки без внешних вертикальных черт. */
function tableRows(number: number): string[][] {
  return section(number)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1));
}

/** Содержимое всех пар обратных кавычек в ячейке. */
function ticks(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? "").trim());
}

export interface ColorToken {
  name: string;
  light: string;
  dark: string;
}

/** §3: токен, значение светлой и значение тёмной темы. Строки вида `a` / `b` дают два токена. */
export function colorTokens(): ColorToken[] {
  return tableRows(3).flatMap((cells) => {
    const names = ticks(cells[0] ?? "");
    const light = ticks(cells[1] ?? "");
    const dark = ticks(cells[2] ?? "");
    if (names.length !== light.length || names.length !== dark.length) {
      throw new Error(`Не сходится число значений в строке §3: ${cells[0]}`);
    }
    return names.map((name, i) => ({ name, light: light[i] ?? "", dark: dark[i] ?? "" }));
  });
}

export interface TextStyle {
  name: string;
  family: "Nunito" | "Manrope";
  size: number;
  lineHeight: number;
  weight: number;
}

/** §5: стили текста. */
export function textStyles(): TextStyle[] {
  return tableRows(5).map((cells) => {
    const [name] = ticks(cells[0] ?? "");
    const family = (cells[1] ?? "").trim();
    const [size, lineHeight] = (cells[2] ?? "").split("/").map((part) => Number(part.trim()));
    const weight = Number((cells[3] ?? "").trim());
    if (!name || (family !== "Nunito" && family !== "Manrope") || !size || !lineHeight || !weight) {
      throw new Error(`Не разобрана строка §5: ${cells.join("|")}`);
    }
    return { name, family, size, lineHeight, weight };
  });
}

export interface ShadcnVariable {
  variable: string;
  token: string;
}

/** §8: переменная shadcn и токен. Один токен на несколько переменных или пары по порядку. */
export function shadcnVariables(): ShadcnVariable[] {
  return tableRows(8).flatMap((cells) => {
    const variables = ticks(cells[0] ?? "");
    const tokens = ticks(cells[1] ?? "");
    return variables.map((variable, i) => ({
      variable,
      token: tokens.length === 1 ? (tokens[0] ?? "") : (tokens[i] ?? ""),
    }));
  });
}

/** §4: бейджи статусов: код статуса и подпись. */
export function lessonStatuses(): { status: string; label: string }[] {
  return tableRows(4).map((cells) => ({
    status: ticks(cells[0] ?? "")[0] ?? "",
    label: (cells[1] ?? "").replaceAll(/[«»]/g, "").trim(),
  }));
}
