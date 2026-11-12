#!/usr/bin/env node
// Генератор типов клиента API из apps/api/openapi.json (ТД §3: openapi-typescript + openapi-fetch).
//   node gen-client.mjs                  пишет packages/client-core/src/api/schema.ts
//   node gen-client.mjs --check          генерирует заново и сравнивает с закоммиченным файлом; код выхода 1 при расхождении
//   --spec <файл>, --out <файл>          другие пути (нужны тестам)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSpec = join(packageRoot, "../../apps/api/openapi.json");
const defaultOut = join(packageRoot, "src/api/schema.ts");

const HEADER = `// Файл создан командой \`pnpm gen:client\` из apps/api/openapi.json. Не правьте его руками.
`;

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function generateSchema(specPath) {
  const ast = await openapiTS(pathToFileURL(resolve(specPath)));
  return `${HEADER}${astToString(ast)}`;
}

async function main(args) {
  const spec = option(args, "--spec") ?? defaultSpec;
  const out = option(args, "--out") ?? defaultOut;
  const generated = await generateSchema(spec);

  if (args.includes("--check")) {
    const committed = existsSync(out) ? readFileSync(out, "utf8") : undefined;
    if (committed !== generated) {
      console.error(
        `Клиент OpenAPI устарел: ${out} не совпадает с ${spec}. Выполните pnpm gen:client и закоммитьте результат.`,
      );
      process.exit(1);
    }
    console.log("Клиент OpenAPI актуален");
    return;
  }

  writeFileSync(out, generated);
  console.log(`Клиент OpenAPI записан: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
