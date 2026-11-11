import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Хук commit-msg из lefthook.yml запускает scripts/check-commit-msg.mjs с путём
// к файлу сообщения. Тест вызывает скрипт так же, как lefthook.
// Проверку настоящим `git commit` делаем вручную, вывод записан в заметках задачи.

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/check-commit-msg.mjs");
const workDir = mkdtempSync(join(tmpdir(), "commit-msg-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function check(message: string) {
  const file = join(workDir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

describe("[SH-002 AC-3] commit-msg проверяет Conventional Commits", () => {
  it.each([
    "исправил баг",
    "Feat: SH-017 вход",
    "feature(auth): SH-017 вход",
    "feat(auth):SH-017 без пробела",
    "feat(auth): ",
    "feat(Auth Module): SH-017 область с пробелом",
    "",
    "# только комментарий\n",
  ])("[SH-002 AC-3] отклоняет сообщение %j", (message) => {
    const result = check(message);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conventional Commits");
  });

  it.each([
    "feat(auth): SH-017 вход через Яндекс ID",
    "fix(schedule): SH-031 перенос слота",
    "test(infra): SH-002 тесты по критериям приёмки",
    "refactor(billing): SH-044 вынес расчёт",
    "docs: SH-002 README",
    "chore: начальные документы",
    "ci: SH-009 проверка покрытия критериев",
    "build(deps): SH-002 обновил Biome",
    "feat(lesson-context)!: SH-049 новый формат итога",
    "feat(auth): SH-017 вход\n\nТело сообщения.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
    "# комментарий git\nfix: SH-002 сообщение после комментария\n",
    "Merge branch 'main' into sh-002-monorepo",
    'Revert "feat(auth): SH-017 вход"',
    "fixup! feat(auth): SH-017 вход",
    "fix: SH-002 сообщение с CRLF\r\n\r\nТело.\r\n",
  ])("[SH-002 AC-3] пропускает сообщение %j", (message) => {
    const result = check(message);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("[SH-002 AC-3] lefthook.yml вызывает проверку в хуке commit-msg", () => {
    const config = readFileSync(join(repoRoot, "lefthook.yml"), "utf8");
    expect(config).toMatch(/^commit-msg:/m);
    expect(config).toContain("node scripts/check-commit-msg.mjs {1}");
  });

  it("[SH-002 AC-3] установка зависимостей ставит git-хуки lefthook", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.prepare).toBe("lefthook install");
  });
});
