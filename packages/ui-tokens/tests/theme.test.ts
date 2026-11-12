import { describe, expect, it } from "vitest";
import { customProperties, normalize, readSrc, stripComments, themePair } from "./support/css.ts";
import { colorTokens, shadcnVariables, textStyles } from "./support/design-system.ts";

const tokensCss = readSrc("tokens.css");
const tokens = customProperties(tokensCss);
const theme = stripComments(readSrc("theme.css"));
const themeVars = customProperties(theme);

describe("[SH-073 AC-3] тема Tailwind CSS v4", () => {
  it("[SH-073 AC-3] тема объявлена как @theme inline и сбрасывает стандартные цвета", () => {
    expect(theme).toMatch(/@theme\s+inline\s*\{/);
    expect(theme).toMatch(/--color-\*:\s*initial;/);
  });

  it("[SH-073 AC-3] white и black сохранены для оверлея и текста shadcn (bg-black/50, text-white)", () => {
    expect(themeVars.get("--color-white")).toBe("#fff");
    expect(themeVars.get("--color-black")).toBe("#000");
  });

  it.each(colorTokens().map((t) => t.name))("[SH-073 AC-3] цвет %s есть в теме Tailwind", (name) => {
    expect(themeVars.get(`--color-${name}`)).toBe(`var(--${name})`);
  });

  it("[SH-073 AC-3] отступы: шаг 4 px и шаги space-1, 2, 3, 4, 6, 8 по §6", () => {
    expect(themeVars.get("--spacing")).toBe("4px");
    const steps = { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 6: "24px", 8: "32px" };
    for (const [step, px] of Object.entries(steps)) {
      expect(tokens.get(`--space-${step}`)).toBe(px);
      // Утилиты p-N, gap-N и другие берут значение у --spacing: N × 4 px.
      expect(Number(step) * 4).toBe(Number.parseInt(px, 10));
    }
  });

  it("[SH-073 AC-3] высоты элементов: control-touch 44, control-desktop 36, tabbar 56", () => {
    expect(tokens.get("--control-touch")).toBe("44px");
    expect(tokens.get("--control-desktop")).toBe("36px");
    expect(tokens.get("--tabbar")).toBe("56px");
    for (const name of ["control-touch", "control-desktop", "tabbar"]) {
      expect(themeVars.get(`--spacing-${name}`)).toBe(`var(--${name})`);
    }
  });

  it("[SH-073 AC-3] радиусы: s 6, m 10, l 14, pill 999; в теме sm, md, lg и pill", () => {
    expect([
      tokens.get("--radius-s"),
      tokens.get("--radius-m"),
      tokens.get("--radius-l"),
      tokens.get("--radius-pill"),
    ]).toEqual(["6px", "10px", "14px", "999px"]);
    expect(themeVars.get("--radius-sm")).toBe("var(--radius-s)");
    expect(themeVars.get("--radius-md")).toBe("var(--radius-m)");
    expect(themeVars.get("--radius-lg")).toBe("var(--radius-l)");
    expect(themeVars.get("--radius-pill")).toBe(tokens.get("--radius-pill"));
  });

  it("[SH-073 AC-3] тени sheet и popover по §6, цвета теней зависят от темы", () => {
    expect(tokens.get("--shadow-sheet")).toBe("0 -8px 24px var(--shadow-sheet-color)");
    expect(themePair(tokensCss, "--shadow-sheet-color")).toEqual({
      light: "rgba(43, 38, 34, 0.12)",
      dark: "rgba(0, 0, 0, 0.45)",
    });
    expect(tokens.get("--shadow-popover")).toBe(
      "0 8px 24px var(--shadow-popover-color-1), 0 2px 6px var(--shadow-popover-color-2)",
    );
    expect(themePair(tokensCss, "--shadow-popover-color-1")).toEqual({
      light: "rgba(43, 38, 34, 0.14)",
      dark: "rgba(0, 0, 0, 0.5)",
    });
    expect(themePair(tokensCss, "--shadow-popover-color-2")).toEqual({
      light: "rgba(43, 38, 34, 0.08)",
      dark: "rgba(0, 0, 0, 0.3)",
    });
    expect(themeVars.get("--shadow-sheet")).toBe(tokens.get("--shadow-sheet"));
    expect(themeVars.get("--shadow-popover")).toBe(tokens.get("--shadow-popover"));
  });

  it("[SH-073 AC-3] семейства шрифтов: заголовки Nunito, текст Manrope, с запасными из §5", () => {
    expect(tokens.get("--font-heading")).toBe('"Nunito", "Manrope", system-ui, sans-serif');
    expect(tokens.get("--font-body")).toBe('"Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    expect(themeVars.get("--font-heading")).toBe(tokens.get("--font-heading"));
    expect(themeVars.get("--font-sans")).toBe("var(--font-body)");
  });

  describe.each(textStyles())("стиль текста $name", ({ name, family, size, lineHeight, weight }) => {
    it(`[SH-073 AC-3] --type-${name} задаёт шрифт, размер, интерлиньяж и вес по §5`, () => {
      const familyVar = family === "Nunito" ? "var(--font-heading)" : "var(--font-body)";
      expect(tokens.get(`--type-${name}`)).toBe(normalize(`${weight} ${size}px/${lineHeight}px ${familyVar}`));
    });

    it(`[SH-073 AC-3] в теме есть утилита ${name}`, () => {
      const block = new RegExp(`@utility\\s+${name}\\s*\\{([^}]*)\\}`).exec(theme);
      expect(block?.[1]).toMatch(new RegExp(`font:\\s*var\\(--type-${name}\\)`));
    });
  });

  it("[SH-073 AC-3] утилита tabular включает табличные цифры", () => {
    expect(/@utility\s+tabular\s*\{[^}]*font-variant-numeric:\s*tabular-nums/.test(theme)).toBe(true);
  });
});

describe("[SH-073 AC-3] переменные shadcn/ui по таблице §8", () => {
  const variables = shadcnVariables();

  it("[SH-073 AC-3] в §8 разобраны все переменные", () => {
    expect(variables.map((v) => v.variable)).toEqual(
      expect.arrayContaining([
        "--background",
        "--foreground",
        "--card",
        "--popover",
        "--primary",
        "--primary-foreground",
        "--secondary",
        "--muted",
        "--accent",
        "--muted-foreground",
        "--destructive",
        "--border",
        "--input",
        "--ring",
        "--radius",
      ]),
    );
  });

  it.each(variables)("[SH-073 AC-3] $variable берёт значение токена $token", ({ variable, token }) => {
    expect(tokens.get(variable)).toBe(`var(--${token})`);
  });

  it.each(variables.filter((v) => v.variable !== "--radius"))(
    "[SH-073 AC-3] утилиты shadcn: --color-$variable в теме Tailwind",
    ({ variable }) => {
      expect(themeVars.get(`--color-${variable.slice(2)}`)).toBe(`var(${variable})`);
    },
  );
});
