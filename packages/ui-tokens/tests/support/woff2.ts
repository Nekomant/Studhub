// Минимальный разбор woff2: достаточно, чтобы узнать, какие символы есть в cmap и какие функции в GSUB.
// Таблицы cmap и GSUB в woff2 не преобразуются, поэтому после распаковки brotli их можно читать как в обычном sfnt.
import { brotliDecompressSync } from "node:zlib";

const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

export interface FontInfo {
  tables: Map<string, Buffer>;
  /** Коды символов, для которых в cmap есть глиф. */
  hasChar(codePoint: number): boolean;
  /** Теги функций GSUB, например `tnum`. */
  gsubFeatures: string[];
}

function readBase128(buf: Buffer, state: { pos: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[state.pos++] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error("Неверное число UIntBase128");
}

export function parseWoff2(buf: Buffer): FontInfo {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("Это не woff2");
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  const state = { pos: 48 };
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[state.pos++] ?? 0;
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag = KNOWN_TAGS[index] ?? "";
    if (index === 63) {
      tag = buf.toString("latin1", state.pos, state.pos + 4);
      state.pos += 4;
    }
    const origLength = readBase128(buf, state);
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    entries.push({ tag, length: transformed ? readBase128(buf, state) : origLength });
  }
  const data = brotliDecompressSync(buf.subarray(state.pos, state.pos + compressedSize));
  const tables = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of entries) {
    tables.set(entry.tag, data.subarray(offset, offset + entry.length));
    offset += entry.length;
  }
  const cmap = tables.get("cmap");
  const gsub = tables.get("GSUB");
  return {
    tables,
    hasChar: (codePoint) => (cmap ? cmapHas(cmap, codePoint) : false),
    gsubFeatures: gsub ? gsubFeatureTags(gsub) : [],
  };
}

function cmapHas(cmap: Buffer, codePoint: number): boolean {
  const count = cmap.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const offset = cmap.readUInt32BE(4 + i * 8 + 4);
    const format = cmap.readUInt16BE(offset);
    if (format === 12) {
      const groups = cmap.readUInt32BE(offset + 12);
      for (let g = 0; g < groups; g++) {
        const at = offset + 16 + g * 12;
        if (codePoint >= cmap.readUInt32BE(at) && codePoint <= cmap.readUInt32BE(at + 4)) return true;
      }
    } else if (format === 4 && codePoint <= 0xffff) {
      const segCount = cmap.readUInt16BE(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segCount * 2 + 2;
      const deltas = starts + segCount * 2;
      const rangeOffsets = deltas + segCount * 2;
      for (let s = 0; s < segCount; s++) {
        if (codePoint > cmap.readUInt16BE(ends + s * 2) || codePoint < cmap.readUInt16BE(starts + s * 2)) continue;
        const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
        if (rangeOffset === 0) {
          if (((codePoint + cmap.readInt16BE(deltas + s * 2)) & 0xffff) !== 0) return true;
        } else {
          const at = rangeOffsets + s * 2 + rangeOffset + (codePoint - cmap.readUInt16BE(starts + s * 2)) * 2;
          if (cmap.readUInt16BE(at) !== 0) return true;
        }
      }
    }
  }
  return false;
}

function gsubFeatureTags(gsub: Buffer): string[] {
  const featureList = gsub.readUInt16BE(6);
  const count = gsub.readUInt16BE(featureList);
  return Array.from({ length: count }, (_, i) =>
    gsub.toString("latin1", featureList + 2 + i * 6, featureList + 6 + i * 6),
  );
}
