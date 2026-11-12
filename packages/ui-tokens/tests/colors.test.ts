import { describe, expect, it } from "vitest";
import { contrast } from "./support/contrast.ts";
import { normalize, readSrc, themePair } from "./support/css.ts";
import { colorTokens } from "./support/design-system.ts";

const tokens = colorTokens();
const css = readSrc("tokens.css");

const pair = (name: string) => themePair(css, `--${name}`);

describe("[SH-073 AC-1] цветовые токены совпадают с design-system.md §3", () => {
  it("[SH-073 AC-1] в документе разобрано 26 цветовых токенов", () => {
    expect(tokens).toHaveLength(26);
  });

  it.each(tokens)("[SH-073 AC-1] --$name: светлая $light, тёмная $dark", ({ name, light, dark }) => {
    expect(pair(name)).toEqual({ light: normalize(light), dark: normalize(dark) });
  });
});

const on = (names: string[], backgrounds: string[]) =>
  names.flatMap((fg) => backgrounds.map((bg) => [fg, bg] as const));

const textPairs = [
  ...on(["ink", "ink-muted"], ["paper", "surface", "sunken"]),
  ...["done", "charge", "pending", "debt", "idle"].map((s) => [`${s}-ink`, `${s}-bg`] as const),
  ["on-plum", "plum"] as const,
  ["on-danger", "danger"] as const,
  ...on(["plum-ink"], ["surface", "paper", "plum-soft"]),
];
const boundaryPairs = on(["line-strong", "focus"], ["paper", "surface", "sunken"]);

describe("[SH-073 AC-5] контраст по WCAG 2", () => {
  for (const theme of ["light", "dark"] as const) {
    it.each(textPairs)(`[SH-073 AC-5] ${theme}: %s на %s не ниже 4,5:1`, (fg, bg) => {
      expect(contrast(pair(fg)[theme], pair(bg)[theme])).toBeGreaterThanOrEqual(4.5);
    });

    it.each(boundaryPairs)(`[SH-073 AC-5] ${theme}: %s на %s не ниже 3:1`, (fg, bg) => {
      expect(contrast(pair(fg)[theme], pair(bg)[theme])).toBeGreaterThanOrEqual(3);
    });
  }

  it("[SH-073 AC-5] функция контраста даёт эталонные значения", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});
