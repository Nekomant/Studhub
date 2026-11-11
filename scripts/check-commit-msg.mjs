#!/usr/bin/env node
// Проверяет заголовок коммита по Conventional Commits (docs/process.md §9).
// Запускается из хука commit-msg (lefthook.yml) с путём к файлу сообщения.

import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "test", "refactor", "docs", "chore", "ci", "build"];
const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: \\S.*$`);
// Сообщения, которые пишет сам git: слияние, отмена, fixup и squash для rebase.
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

const file = process.argv[2];
if (!file) {
  console.error("Использование: check-commit-msg.mjs <файл сообщения>");
  process.exit(2);
}

const header =
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((line) => line.trim() !== "" && !line.startsWith("#"))
    ?.trimEnd() ?? "";

if (!HEADER.test(header) && !GIT_GENERATED.test(header)) {
  console.error(
    [
      `Заголовок коммита не по Conventional Commits: ${JSON.stringify(header)}`,
      "",
      "Формат: <тип>(<область>): <описание>, область можно опустить.",
      `Типы: ${TYPES.join(", ")}.`,
      "Пример: feat(schedule): SH-030 генерация уроков по слотам",
      "Правила: docs/process.md §9.",
    ].join("\n"),
  );
  process.exit(1);
}
