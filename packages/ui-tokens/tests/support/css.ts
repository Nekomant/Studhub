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
    .replaceAll(/\s*\/\s*/g, "/")
    .replaceAll(/(\d\.\d*?)0+(?![\d])/g, "$1")
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

/** Объявления `--name: value;` одного правила, выбранного по списку селекторов (`:root, .light`). */
export function blockProperties(css: string, selectors: string): Map<string, string> {
  const wanted = normalize(selectors);
  const result = new Map<string, string>();
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (normalize(rule[1] ?? "") === wanted) {
      for (const [name, value] of customProperties(rule[2] ?? "")) result.set(name, value);
    }
  }
  return result;
}

/** Значения токена в светлой теме (`:root, .light`) и в тёмной (`.dark`). */
export function themePair(css: string, name: string): { light: string; dark: string } {
  const light = blockProperties(css, ":root, .light").get(name);
  const dark = blockProperties(css, ".dark").get(name);
  if (light === undefined || dark === undefined) {
    throw new Error(`В tokens.css нет ${name} одновременно в блоках ":root, .light" и ".dark"`);
  }
  return { light, dark };
}
