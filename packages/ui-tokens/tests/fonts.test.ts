import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSrc, stripComments } from "./support/css.ts";
import { fontsDir, srcDir } from "./support/paths.ts";
import { parseWoff2 } from "./support/woff2.ts";

const faces = [
  { family: "Nunito", weight: 800, file: "nunito" },
  { family: "Manrope", weight: 300, file: "manrope" },
  { family: "Manrope", weight: 400, file: "manrope" },
  { family: "Manrope", weight: 600, file: "manrope" },
].flatMap((face) => (["latin", "cyrillic"] as const).map((subset) => ({ ...face, subset })));

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const needed = {
  latin: [...range(0x41, 0x5a), ...range(0x61, 0x7a), ...range(0x30, 0x39), 0x2212, 0x2014],
  cyrillic: [...range(0x410, 0x44f), 0x401, 0x451],
};
const fileName = (f: (typeof faces)[number]) => `${f.file}-${f.subset}-${f.weight}-normal.woff2`;

describe("[SH-073 AC-4] файлы шрифтов", () => {
  it("[SH-073 AC-4] в fonts/ ровно 8 файлов woff2 и лицензии OFL", () => {
    const files = readdirSync(fontsDir).sort();
    expect(files.filter((f) => f.endsWith(".woff2"))).toEqual(faces.map(fileName).sort());
    expect(files.filter((f) => f.startsWith("OFL-"))).toEqual(["OFL-Manrope.txt", "OFL-Nunito.txt"]);
  });

  describe.each(faces)("$family $weight $subset", (face) => {
    const path = join(fontsDir, fileName(face));
    const font = () => parseWoff2(readFileSync(path));

    it(`[SH-073 AC-4] ${fileName(face)} в cmap есть символы подмножества ${face.subset}`, () => {
      const parsed = font();
      const missing = needed[face.subset].filter((code) => !parsed.hasChar(code));
      expect(missing.map((code) => `U+${code.toString(16).toUpperCase()}`)).toEqual([]);
    });

    if (face.subset === "latin") {
      it(`[SH-073 AC-4] ${fileName(face)} поддерживает табличные цифры (GSUB tnum)`, () => {
        expect(font().gsubFeatures).toContain("tnum");
      });
    }
  });
});

describe("[SH-073 AC-4] @font-face и отсутствие внешних адресов", () => {
  const css = stripComments(readSrc("fonts.css"));
  const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");

  it("[SH-073 AC-4] есть 8 блоков @font-face", () => {
    expect(blocks).toHaveLength(8);
  });

  it.each(faces)("[SH-073 AC-4] @font-face $family $weight $subset подключает свой файл", (face) => {
    const block = blocks.find((b) => b.includes(`/${fileName(face)}`));
    expect(block, fileName(face)).toBeDefined();
    expect(block).toMatch(new RegExp(`font-family:\\s*["']${face.family}["']`));
    expect(block).toMatch(new RegExp(`font-weight:\\s*${face.weight}\\b`));
    expect(block).toMatch(/format\(["']woff2["']\)/);
    expect(block).toMatch(/font-display:\s*swap/);
    expect(block).toMatch(/unicode-range:/);
    const url = /url\(["']?([^"')]+)["']?\)/.exec(block ?? "")?.[1] ?? "";
    expect(existsSync(resolve(srcDir, url))).toBe(true);
  });

  it("[SH-073 AC-4] в CSS и HTML пакета нет внешних адресов и @import с http", () => {
    const files = readdirSync(srcDir).filter((f) => /\.(css|html)$/.test(f) && statSync(join(srcDir, f)).isFile());
    expect(files).toEqual(expect.arrayContaining(["tokens.css", "theme.css", "fonts.css", "index.css", "sample.html"]));
    for (const file of files) {
      expect(stripComments(readSrc(file)), file).not.toMatch(/(?:https?:)?\/\/[a-z0-9-]+\.[a-z]/i);
    }
  });
});
