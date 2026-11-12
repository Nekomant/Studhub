import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { srcDir } from "./paths.ts";

export function readSrc(file: string): string {
  return readFileSync(resolve(srcDir, file), "utf8");
}

export function stripComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

/** Приводит значение к виду для сравнения: пробелы сжаты, регистр шестнадцатеричных цветов нижний. */
export function normalize(value: string): string {
  return value
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*,\s*/g, ", ")
    .replaceAll(/#[0-9a-f]{3,8}\b/gi, (hex) => hex.toLowerCase())
    .trim();
}

/** Все объявления `--name: value;` файла. Если имя повторяется, берётся первое. */
export function customProperties(css: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const name = match[1] ?? "";
    if (!result.has(name)) result.set(name, normalize(match[2] ?? ""));
  }
  return result;
}

/** Разбор `light-dark(a, b)` с учётом запятых внутри скобок. */
export function parseLightDark(value: string): [string, string] | undefined {
  const match = /^light-dark\((.*)\)$/s.exec(value.trim());
  if (!match) return undefined;
  const inner = match[1] ?? "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) return [normalize(inner.slice(0, i)), normalize(inner.slice(i + 1))];
  }
  return undefined;
}
