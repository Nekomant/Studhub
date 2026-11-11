---
id: SH-009
title: CI в GitHub Actions и проверка покрытия критериев
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-11T22:23:00Z'
labels:
  - infra
milestone: m-0
dependencies: []
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Создать workflow GitHub Actions на PR и push в `main`. Он запускает проверки, которые есть в проекте сейчас: установка с кэшем pnpm, `pnpm check` (Biome и `tsc`), `pnpm test` (Vitest) на сервисе `postgres:18` с `TEST_DATABASE_URL`, `pnpm db:check`.
2. Написать `scripts/check-ac-coverage`: берёт задачи в статусах Review и Done из Backlog.md (`backlog task list --json` или файлы `backlog/tasks`), ищет метки `[SH-NNN AC-n]` в тестах и печатает непокрытые критерии. Покрыть скрипт юнит-тестом на фикстурах и подключить в workflow.
3. Создать `.github/pull_request_template.md` по `docs/process.md` §9–10.
4. На тестовом PR убедиться, что каждый вид сломанной проверки делает CI красным, и записать время прогона.
5. Владелец: включить защиту `main` так, чтобы слияние было возможно только при зелёном CI (имя обязательной проверки сообщит рабочая сессия).

## Зачем
Процесс «спецификация → тесты → код» держится на автоматических проверках: PR с красными проверками или непокрытыми критериями не должен сливаться. Сейчас CI нет, поэтому DoD «CI зелёный» нельзя выполнить: у SH-005, SH-077 и SH-078 этот пункт остался открытым. Задачу сузили до проверок, которые уже есть (решение владельца, 2026-11-12), чтобы не ждать каркас SPA и Dockerfile. Остальные проверки ТД §12 добавят задачи, которые создают то, что проверяется: SH-006, SH-008 и SH-011.

## Контекст
- ТД §12 «CI»; `docs/process.md` §6 (DoD), §8.2 (метки `[SH-NNN AC-n]`), §9 (PR).
- `package.json`: команды `check`, `test`, `db:check`, `db:up`; `.env.example`: переменные тестовой БД.
- Репозиторий на GitHub уже создан и подключён как `origin`, слияние в `main` идёт только через PR со squash.

## Не входит
- Клиент OpenAPI и `pnpm test:api`: SH-006 добавит шаги в workflow.
- Playwright E2E: SH-008.
- Сборка образа и публикация в GHCR: SH-011.
- Деплой.

## Контракт
Нет.

## План тестов
| AC | Уровень | Проверка |
|---|---|---|
| 1 | Ручная | PR с намеренно сломанной проверкой каждого вида (Biome, tsc, тест, миграция) → красный |
| 2 | Юнит | скрипт на фикстурах задач и тестов |
| 3 | Ручная | шаблон PR |
| 4 | Ручная | время прогона в заметках |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 На каждый PR и push в `main` выполняются Biome, `tsc`, Vitest на `postgres:18` и `db:check`; упавший шаг делает проверку красной
- [ ] #2 `scripts/check-ac-coverage` для каждой задачи в статусе Review или Done проверяет, что каждый критерий приёмки упомянут меткой `[SH-NNN AC-n]` хотя бы в одном тесте, и падает со списком непокрытых; скрипт входит в CI
- [ ] #3 Шаблон PR содержит: ссылку на задачу, что сделано, как проверено, изменения документов, чек-лист ревью из `docs/process.md` §10
- [ ] #4 Прогон CI на текущем проекте занимает не больше 10 минут благодаря кэшу
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [ ] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [ ] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [ ] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
- [ ] #8 Владелец создал приватный репозиторий на GitHub и включил защиту `main`: слияние только через PR при зелёном CI
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Корневой скрипт db:check (алиас на pnpm --filter @studhub/api db:check), как gen:openapi.
2. Красный юнит-тест [SH-009 AC-2] на фикстурах задач и тестов в tools/tests/check-ac-coverage.test.ts; отдельный коммит.
3. scripts/check-ac-coverage.mjs: читает backlog/tasks/*.md (frontmatter status, список критериев), ищет метки [SH-NNN AC-n] и [SH-NNN AC-n, AC-m] в тестовых файлах, печатает непокрытые и выходит с кодом 1. Правило для ручных критериев — по ответу владельца.
4. .github/workflows/ci.yml: on pull_request и push в main; job check: checkout, pnpm/action-setup, setup-node с cache pnpm и .nvmrc, pnpm install --frozen-lockfile, pnpm check, pnpm db:check, check-ac-coverage, pnpm test с сервисом postgres:18 и TEST_DATABASE_URL.
5. .github/pull_request_template.md по process §9–10.
6. Документы: process §8.2 и §9 (CI, шаблон PR, правило покрытия), README.
7. Ручная проверка на тестовом PR: сломать Biome, tsc, тест, миграцию — каждый красный; время прогона в заметки.
8. Владелец: защита main с обязательной проверкой.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 4 ч

Ждёт владельца: как check-ac-coverage обходится с критериями, которые по плану тестов проверяются вручную или ревью (сейчас без меток SH-075 AC-1..6, SH-077 AC-3, 9, 10, SH-078 AC-1, 2, 5; у самой SH-009 AC-1, 3, 4).
<!-- SECTION:NOTES:END -->
