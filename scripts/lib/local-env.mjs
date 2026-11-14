// Локальные переменные окружения из `.env` (docs/process.md §7.1). Модуль общий для хука SessionStart
// (scripts/hooks/session-env.mjs) и фабрики (scripts/factory.mjs): список разрешённых переменных лежит здесь один.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Единственный список переменных, которые хук и фабрика передают в сессию и в процесс claude.
// Новую переменную добавляем сюда и в docs/process.md §7.1.
export const ALLOWED = ["POSTGRES_PORT", "DATABASE_URL", "TEST_DATABASE_URL"];

// Простой разбор `<dir>/.env`: KEY=VALUE, комментарии и пустые строки пропускаются, берутся только переменные из ALLOWED.
// Значение в кавычках берётся до закрывающей кавычки, комментарий после неё отбрасывается. Нет файла — пустой объект.
export function readLocalEnv(dir) {
  const vars = {};
  const path = join(dir, ".env");
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (!ALLOWED.includes(match[1])) continue;
    const quoted = /^(["'])(.*?)\1(\s+#.*)?$/.exec(match[2]);
    vars[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, "");
  }
  return vars;
}
