---
id: SH-077
title: Агент sh-worker для задач и экономия контекста
status: Done
assignee:
  - '@claude'
created_date: '2026-11-11T20:53:00Z'
updated_date: '2026-11-11T21:40:00Z'
labels:
  - infra
  - docs
milestone: m-0
dependencies: []
references:
  - docs/process.md
  - https://code.claude.com/docs/en/sub-agents
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Создать субагента `.claude/agents/sh-worker.md` для работы над одной задачей SH-NNN по `docs/process.md` §7. В `tools` оставить только `Read, Edit, Write, Bash, Grep, Glob` и при необходимости `Agent` для поиска по документам. `Skill` и MCP-инструменты не давать. Задать `model`, `effort`, `maxTurns`, `autoCompactWindow`. В теле агента описать точки остановки: задача не в Ready, шаг «Владелец:», план меняет решение из ТД или ADR, работа вне критериев. В этих точках агент завершается и возвращает родительской сессии вопрос.
2. Создать скилл `.claude/skills/sh-task/SKILL.md` с чеклистами старта и финиша задачи из `docs/process.md` §7 и §10. В финиш включить отметку пунктов DoD. Подключить его к агенту через поле `skills`.
3. Добавить агенту хук PreToolUse (поле `hooks` в файле агента): он блокирует Edit и Write файлов в `backlog/` с кодом выхода 2, остальные пути пропускает.
4. Написать `scripts/task.mjs SH-NNN`: читает `backlog task view --json` и печатает задачу без поля `dependencyGraph`.
5. Написать `scripts/doc.mjs <документ> <раздел>`: печатает один раздел ТД, `use-cases.md` или `screens.md`.
6. Добавить `pnpm verify`: `pnpm check` и тесты с коротким выводом (только итог при успехе, только упавшие тесты при ошибке).
7. Сделать так, чтобы `git status` показывал кириллические пути без восьмеричных кодов (`core.quotepath false`) в каждом клоне и worktree после `pnpm install`.
8. Сделать так, чтобы сессия в новом worktree получала локальные переменные окружения (сейчас `POSTGRES_PORT=5434`) без ручного `export` в каждой команде. Владелец: создать `.env` в основной папке, если выбранный способ его требует; агент `.env` не создаёт и не читает.
9. Замерить стартовый контекст `sh-worker` по транскрипту (первый запрос субагента в `~/.claude/projects/.../subagents/`) и записать в заметки рядом с базой обычной сессии.
10. Описать в `docs/process.md` §7 и в `CLAUDE.md`, когда сессия задачи вызывает `sh-worker`, как передаёт ему ответы владельца и что документы читаются по разделам через `scripts/doc.mjs`.
11. Написать тесты по критериям.

## Зачем
Аудит прошлых сессий (2026-11-12) показал, что каждая сессия начинает работу с 74–77 тыс. токенов в контексте, ещё не прочитав задачу. Основная часть уходит на описания примерно 150 скиллов и 15 агентов из плагинов и на системный промпт харнеса. Дальше контекст растёт из-за чтения документов целиком (ТД 826 строк, `use-cases.md` 841, `screens.md` 1340) и лишнего вывода команд. Например, `backlog task view SH-005 --plain` выдаёт 20,5 тыс. знаков, из них около 9 тыс. занимает дерево зависимых задач. Рабочие сессии доходили до 137–367 тыс. токенов.

Отдельный агент для задач получает свой системный промпт, свои инструменты и хуки. Штаб, дизайн-сессии и остальная работа в воркспейсе от этого не меняются. Поэтому ключ `agent` в `.claude/settings.json` не подходит: он превращает в агента каждую сессию проекта.

Ограничение: субагент не может задать вопрос владельцу (`AskUserQuestion` у субагентов убран). Разговор с владельцем, карточка задачи и PR остаются у сессии задачи в приложении, тяжёлая работа уходит в `sh-worker`.

## Контекст
- `docs/process.md` §4 (структура задачи), §7 (жизненный цикл), §10 (ревью).
- `CLAUDE.md` проекта: правила работы над задачей.
- Документация Claude Code о субагентах: поля `tools`, `skills`, `hooks`, `model`, `effort`, `maxTurns`, `autoCompactWindow`; https://code.claude.com/docs/en/sub-agents

## Не входит
- Выключение плагинов для всего проекта (`enabledPlugins`): отдельное решение владельца.
- Скрипт `check-ac-coverage` и CI: SH-009.
- Изменение работы штаба и перевод в Ready через коммит: отдельно, если понадобится после пробы агента.
- Перевод реальной задачи на `sh-worker`: первая задача после этой.

## Контракт
API и БД не меняются. Новые файлы: `.claude/agents/sh-worker.md`, `.claude/skills/sh-task/SKILL.md`, скрипт хука, `scripts/task.mjs`, `scripts/doc.mjs`; новая команда `pnpm verify`.

## План тестов
| AC | Уровень | Тест |
|---|---|---|
| 1 | Unit (Vitest) | frontmatter `sh-worker.md`: нет `Skill` и MCP в `tools`, `skills` содержит `sh-task`; в `.claude/settings.json` нет ключа `agent` |
| 2 | Unit (Vitest) | скрипт хука на JSON с путём в `backlog/` выходит с кодом 2, на другом пути с кодом 0 |
| 3 | Ручная | запуск `sh-worker` на задаче не в Ready: агент останавливается и возвращает вопрос |
| 4 | Unit (Vitest) | `task.mjs` на SH-005: нет дерева зависимостей, есть критерии и итог, вывод минимум вдвое короче |
| 5 | Unit (Vitest) | `doc.mjs` печатает раздел ТД §4.1; на несуществующем разделе код не 0 и список разделов |
| 6 | Скрипт | `pnpm verify` на зелёной ветке печатает не больше 20 строк; на фикстуре с падающим тестом печатает его имя |
| 7 | Скрипт | в новом worktree после `pnpm install` `git config core.quotepath` равен `false` |
| 8 | Ручная | команда в новом worktree видит `POSTGRES_PORT` без `export` |
| 9 | Ручная | замер в заметках задачи |
| 10 | Ручная | чтение `docs/process.md` §7 и `CLAUDE.md` |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Субагент `.claude/agents/sh-worker.md` есть; в его `tools` нет `Skill` и MCP-инструментов, поле `skills` загружает `sh-task`; в `.claude/settings.json` нет ключа `agent`, поэтому другие сессии проекта работают как раньше
- [x] #2 Хук `sh-worker` блокирует Edit и Write файлов в `backlog/` с кодом выхода 2 и пропускает остальные пути
- [x] #3 Дано задача не в статусе Ready. Когда `sh-worker` получает её ID, тогда он не меняет файлы и возвращает родительской сессии вопрос. Так же он останавливается на шаге «Владелец:», на плане, который меняет решение из ТД или ADR, и на работе вне критериев
- [x] #4 `node scripts/task.mjs SH-NNN` печатает описание, критерии, DoD, план, заметки и итог задачи без дерева зависимостей; для SH-005 вывод минимум вдвое короче `backlog task view SH-005 --plain`
- [x] #5 `node scripts/doc.mjs <документ> <раздел>` печатает один раздел ТД, `use-cases.md` или `screens.md`; для несуществующего раздела завершается с кодом не 0 и печатает список разделов
- [x] #6 `pnpm verify` запускает `pnpm check` и тесты; при зелёных проверках печатает не больше 20 строк, при падении печатает имена упавших тестов и их ошибки
- [x] #7 В новом worktree после `pnpm install` `git status` показывает кириллические пути без восьмеричных кодов
- [x] #8 Команда в сессии нового worktree видит локальный `POSTGRES_PORT` без `export` в самой команде; агент не создаёт и не читает `.env`
- [x] #9 Стартовый контекст `sh-worker` (первый запрос по транскрипту) записан в заметки рядом с базой обычной сессии 74–77 тыс. токенов и меньше неё
- [x] #10 `docs/process.md` §7 и `CLAUDE.md` описывают, когда сессия задачи вызывает `sh-worker`, как передаёт ему ответы владельца и что документы читаются по разделам через `scripts/doc.mjs`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [x] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [x] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [x] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Сверить поля субагента с документацией (сделано: tools, skills, hooks, model, effort, maxTurns, autoCompactWindow работают как задумано; Claude Code 2.1.319).
2. Спросить владельца о способе AC-8 (переменные окружения в новом worktree).
3. Красные тесты в tools/tests/sh-worker.test.ts по AC-1, 2, 4, 5, 6, 7, 8; отдельный коммит.
4. .claude/agents/sh-worker.md: tools Read, Edit, Write, Bash, Grep, Glob; skills: sh-task; hooks PreToolUse на Edit|Write -> scripts/hooks/block-backlog-edit.mjs; model, effort, maxTurns, autoCompactWindow; точки остановки в теле.
5. .claude/skills/sh-task/SKILL.md: чеклисты старта и финиша по process.md §7, §10 и DoD.
6. scripts/task.mjs (backlog task view --json без dependencyGraph), scripts/doc.mjs (раздел документа по номеру или ID).
7. scripts/verify.mjs и pnpm verify: pnpm check плюс vitest с репортёром minimal; при успехе только итог.
8. core.quotepath false через скрипт prepare при pnpm install.
9. AC-8 выбранным способом.
10. Живой запуск sh-worker на SH-006 (Backlog): проверить остановку, замерить первый запрос по транскрипту.
11. docs/process.md §7 и CLAUDE.md.
12. pnpm check, pnpm test, /code-review, PR, статус Review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч

Решение: поля субагента сверены с документацией (Claude Code 2.1.319). skills вкладывает скилл целиком без инструмента Skill; hooks в файле агента работают только пока агент активен и только в доверенной папке; autoCompactWindow от 100000 и действует, только если ниже окна сессии. Agent в tools не дал: документы агент читает через scripts/doc.mjs, вложенные агенты добавили бы свой контекст.
Решение: Grep и Glob в tools оставлены, но в текущей сборке Claude Code этих инструментов нет (их нет и у обычной сессии), Claude Code их пропускает. В транскрипте у агента инструменты Read, Edit, Write, Bash.
Решение: setup-git.mjs запускается из postinstall, а не из prepare: тест SH-002 AC-3 требует prepare ровно «lefthook install». На pnpm install с актуальным lockfile («Already up to date») pnpm 12 скрипты не запускает; в новом worktree node_modules нет, установка полная, скрипт срабатывает.
Решение: при статусе In Progress агент продолжает работу, только если сессия задачи сказала «продолжение»; любой другой статус кроме Ready при новом старте ведёт к остановке.
AC-7 вручную: свежий клон, новый worktree, pnpm install. До: core.quotepath пусто, git status показывает "\320\267...md"; после: core.quotepath=false, git status показывает «?? задача.md».
AC-3 вручную: новая headless-сессия (claude -p, сессия 18f29e00) вызвала sh-worker с «Новый старт задачи SH-006.» (SH-006 в Backlog). Агент вернул «СТОП SH-006: задача в статусе Backlog, а не Ready…» с вопросом и вариантами А/Б и «Сделано: ничего не менял». Проверка: HEAD тот же, git status пуст, md5 файла SH-006 не изменился.
AC-2 вживую: headless-сессия 4af8b008, sh-worker вызвал Write в backlog/tasks/probe-hook.md и получил «PreToolUse:Write hook error: … Файлы в backlog/ правятся только через CLI backlog…», файл не создан; Write вне backlog/ прошёл.
AC-9 замер первого запроса по транскриптам (input + cache_creation + cache_read):
- sh-worker (opus, субагент agent-adcf67b3d5dce0cd8): 9 830 токенов; системный промпт агента 4 894 знака, скилл sh-task вложен; весь запуск на SH-006: 3 запроса, последний 12 570.
- база, обычная сессия задачи (эта сессия ee4a93ef, opus): 76 949 токенов; в аудите 74–77 тыс.
- для сравнения headless-сессия на sonnet без истории (18f29e00): 34 681 токен.
Итого стартовый контекст sh-worker в 7,8 раза меньше обычной сессии.

Доказательства: tools/tests/sh-worker.test.ts, 29 тестов зелёные (AC-1, 2, 4, 5, 6, 7, 8 и регрессии). pnpm verify на ветке: «pnpm check: ок», 12 файлов, 161 тест, 6 строк вывода (AC-6). AC-10: docs/process.md §7.1 и раздел «Агент sh-worker и экономия контекста» в CLAUDE.md.
/code-review (high) по диффу ветки: 8 замечаний, 6 исправлено (NODE_ENV не передаётся из .env, кавычки при комментарии, хук блокирует при битом входе, grep вместо Grep в промпте агента, verify убирает только первый --, один вызов git). Не исправлено: тест AC-4 на SH-005 пропускается без CLI backlog (решить в SH-009, когда появится CI); хук не ловит правку backlog/ через Bash (вне AC-2, в промпте агента запрет).
Ждёт владельца: AC-8. Нужно выбрать способ (А: хук SessionStart, уже сделан и покрыт тестами; Б: .worktreeinclude) и создать .env в основной папке с POSTGRES_PORT=5434 и URL на 5434. После этого проверю вживую: новая сессия в новом worktree, echo $POSTGRES_PORT без export.
Факт: 1,2 ч

Решение по AC-8 (владелец, через штаб): вариант А, «только разрешённые». Хук session-env передаёт только переменные из списка ALLOWED в скрипте: POSTGRES_PORT, DATABASE_URL, TEST_DATABASE_URL. Остальное из .env пропускает, ошибки не роняют старт сессии. Тест: переменные не из списка (NODE_ENV, S3_SECRET_ACCESS_KEY, POSTGRES_PASSWORD) в CLAUDE_ENV_FILE не попадают. Описание в docs/process.md §7.1 и CLAUDE.md.
Владелец создал .env в основной папке (проверено только наличие файла, содержимое агент не читал).
AC-8 вживую: временный worktree (git worktree add --detach, своего .env нет), новая headless-сессия d2a3daa7 без POSTGRES_PORT в окружении запуска. printenv POSTGRES_PORT → 5434, код 0; printenv S3_REGION → пусто, код 1; printenv NODE_ENV → пусто, код 1. Предполагаю, что S3_REGION есть в .env владельца, как в .env.example. Worktree удалён.
pnpm verify после правки: check ок, 162 теста.
Факт: 1,6 ч

PR #12 слит владельцем в main (merge 282fc67, 2026-11-11 21:38 UTC). Слит обычным merge, а не squash, как требует process.md §9. DoD #2 закроется, когда появится CI (SH-009); DoD #6 (выкладка в prod) закроется с деплоем (SH-011). Задача закрыта.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Добавлен субагент sh-worker для работы над одной задачей: свой короткий промпт, инструменты Read, Edit, Write, Bash, скилл sh-task с чеклистами старта и финиша, хук против правки backlog/ через Edit и Write. Первый запрос агента 9 830 токенов против 76 949 у обычной сессии. На задаче не в Ready (SH-006) агент остановился, ничего не изменив, и вернул вопрос с вариантами.
Скрипты короткого вывода: scripts/task.mjs (задача без дерева зависимых, SH-005: 9,5 тыс. знаков против 20,4 тыс.), scripts/doc.mjs (один раздел ТД, UC или экранов), pnpm verify (6 строк на зелёной ветке, при падении только упавшие тесты). core.quotepath false ставится в postinstall. Хук SessionStart передаёт из .env основной папки только POSTGRES_PORT, DATABASE_URL и TEST_DATABASE_URL; новая сессия в новом worktree видит POSTGRES_PORT=5434 без export.
Проверено: 30 тестов SH-077, pnpm verify (162 теста), живые запуски агента и новой сессии через claude -p, свежий клон с новым worktree для AC-7. Документы: docs/process.md §7.1, CLAUDE.md.
Открыто: тест AC-4 на SH-005 пропускается без CLI backlog, решить в SH-009 с CI. Хук не ловит правку backlog/ через Bash, запрет только в промпте агента. Перевод реальной задачи на sh-worker: следующая задача.
<!-- SECTION:FINAL_SUMMARY:END -->
