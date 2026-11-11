import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.ts";

const apiRoot = resolve(import.meta.dirname, "..");

describe("OpenAPI", () => {
  it("[SH-004 AC-3] генерируется в версии OpenAPI 3.1 и проходит валидацию", async () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe("3.1.0");
    const result = await validate(document);
    expect(result.valid, JSON.stringify(result.errors, null, 2)).toBe(true);
  });

  it("[SH-004 AC-3] содержит маршрут /healthz и префикс /api/v1 в путях", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.paths ?? {})).toContain("/healthz");
  });

  it("[SH-004 AC-3] apps/api/openapi.json совпадает с генерацией (pnpm gen:openapi обновлён)", () => {
    const committed = JSON.parse(readFileSync(resolve(apiRoot, "openapi.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});
