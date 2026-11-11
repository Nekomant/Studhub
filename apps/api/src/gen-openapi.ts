// Команда `pnpm gen:openapi`: пишет apps/api/openapi.json.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiDocument } from "./openapi.ts";

const outPath = resolve(import.meta.dirname, "..", "openapi.json");
writeFileSync(outPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI записан: ${outPath}`);
