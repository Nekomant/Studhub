#!/usr/bin/env node
// `pnpm verify`: все проверки перед PR с коротким выводом для агента.
// 1. `pnpm check` (Biome и tsc). При успехе одна строка, при ошибке весь вывод.
// 2. `vitest run` с репортёром minimal. При успехе только итог, при падении имена упавших тестов и их ошибки.
// Флаг --no-check пропускает шаг 1. Остальные аргументы уходят в vitest, например `-- --project tools`.
import { spawnSync } from "node:child_process";

// pnpm передаёт `--` из `pnpm verify -- …` как есть: убираем только первый.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const skipCheck = args.includes("--no-check");
const vitestArgs = args.filter((arg) => arg !== "--no-check");
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

// Убирает шапку vitest, время старта и лишние пустые строки.
function compact(output) {
  return output
    .split("\n")
    .filter((line) => !/^\s*RUN\s+v\d/.test(line) && !/^\s*Start at\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

if (!skipCheck) {
  const check = run("pnpm", ["--silent", "check"]);
  if (check.status !== 0) {
    process.stdout.write(`pnpm check: ошибка\n${check.output.trim()}\n`);
    process.exit(check.status);
  }
  process.stdout.write("pnpm check: ок\n");
}

const tests = run("pnpm", ["exec", "vitest", "run", "--reporter=minimal", ...vitestArgs]);
if (tests.status === 0) {
  const summary = compact(tests.output)
    .split("\n")
    .filter((line) => /^\s*(Test Files|Tests|Duration)\s/.test(line))
    .map((line) => line.trim());
  process.stdout.write(`тесты: ок\n${summary.join("\n")}\n`);
} else {
  process.stdout.write(`тесты: ошибка\n${compact(tests.output)}\n`);
}
process.exit(tests.status);
