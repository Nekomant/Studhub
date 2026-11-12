import { resolve } from "node:path";

export const packageDir = resolve(import.meta.dirname, "../..");
export const repoRoot = resolve(packageDir, "../..");
export const srcDir = resolve(packageDir, "src");
export const fontsDir = resolve(srcDir, "fonts");
