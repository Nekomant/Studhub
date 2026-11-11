#!/usr/bin/env node
// Проверка, что миграции соответствуют схеме Drizzle. Сначала проверяем цепочку снимков drizzle-kit,
// потом генерируем миграцию во временной копии папки drizzle/. Репозиторий при этом не меняется.
// Если схема отличается от миграций, генератор создаёт файл в копии, и проверка падает с кодом 1.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const drizzleKit = join(apiRoot, "node_modules/drizzle-kit/bin.cjs");
const drizzleDir = join(apiRoot, "drizzle");

// Схема по умолчанию совпадает с drizzle.config.ts. Флаг --schema нужен тестам: проверяем файл-фикстуру.
const schemaFlagIndex = process.argv.indexOf("--schema");
const schema = schemaFlagIndex === -1 ? "./src/modules/*/db/schema.ts" : process.argv[schemaFlagIndex + 1];

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const chain = spawnSync(process.execPath, [drizzleKit, "check"], { cwd: apiRoot, encoding: "utf8" });
if (chain.status !== 0) {
  process.stdout.write(chain.stdout);
  process.stderr.write(chain.stderr);
  console.error("Цепочка миграций повреждена: drizzle-kit check не прошёл.");
  process.exit(1);
}

function compareWithSchema(tempRoot) {
  const tempDrizzle = join(tempRoot, "drizzle");
  cpSync(drizzleDir, tempDrizzle, { recursive: true });
  const before = listFiles(tempDrizzle);

  const generated = spawnSync(
    process.execPath,
    [
      drizzleKit,
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      schema,
      "--out",
      relative(apiRoot, tempDrizzle),
      "--name",
      "db_check",
    ],
    { cwd: apiRoot, encoding: "utf8" },
  );
  const output = `${generated.stdout}${generated.stderr}`;
  const added = listFiles(tempDrizzle).filter((file) => !before.includes(file));

  // drizzle-kit иногда печатает ошибку и всё равно завершается с кодом 0, поэтому успех проверяем по тексту.
  if (generated.status !== 0 || /\bError\b/.test(output)) {
    process.stdout.write(generated.stdout);
    process.stderr.write(generated.stderr);
    console.error("Не удалось сравнить схему с миграциями: drizzle-kit generate завершился с ошибкой.");
    return 1;
  }
  if (added.length > 0) {
    console.error("Схема изменена, а миграция не сгенерирована. Запустите pnpm db:generate и закоммитьте новый файл:");
    for (const file of added) console.error(`- ${relative(tempRoot, file)}`);
    return 1;
  }
  if (!output.includes("No schema changes")) {
    console.error(
      "Не удалось подтвердить, что схема совпадает с миграциями: drizzle-kit не сообщил об отсутствии изменений.",
    );
    return 1;
  }
  console.log("Схема соответствует миграциям.");
  return 0;
}

// Временная папка внутри apiRoot: drizzle-kit принимает --out только относительный путь.
// process.exit не вызываем внутри try: он пропускает finally и оставил бы временную папку.
// Родительскую папку создаём сами: в чистом клоне node_modules/.cache может отсутствовать.
const cacheDir = join(apiRoot, "node_modules/.cache");
mkdirSync(cacheDir, { recursive: true });
const tempRoot = mkdtempSync(join(cacheDir, "db-check-"));
let code;
try {
  code = compareWithSchema(tempRoot);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(code);
