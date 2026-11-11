---
id: SH-005
title: Drizzle и миграции
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-11T19:31:00Z'
labels:
  - backend
  - db
milestone: m-0
dependencies:
  - SH-004
priority: high
type: chore
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Подключить Drizzle ORM и drizzle-kit: схемы в `modules/*/db/schema.ts`, миграции в `apps/api/drizzle/`.
2. Добавить скрипты `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:check`.
3. Добавить команду `migrate`: собранное приложение, запущенное с этим аргументом, применяет миграции и завершается.
4. Создать первую миграцию, включающую расширение `pg_trgm`.
5. Написать `apps/api/src/modules/README.md` с соглашениями ТД §4.1 и примером таблицы арендатора.
6. Проверить двойной запуск миграций и падение `db:check` при изменённой схеме без миграции; результат записать в заметки.

## Зачем
Схема БД — SQL-миграции на ревью (ТД §1, принцип 1). Миграции должны применяться одинаково локально, в тестах и в CD.

## Контекст
- ТД §3 (БД), §4.1 (соглашения), §12 (CD: `docker compose run --rm app migrate`, миграции только вперёд).
- ADR-0002.

## Не входит
Таблицы предметной области — с этапа 1.

## Контракт
Миграция `0000`: `CREATE EXTENSION IF NOT EXISTS pg_trgm`.

## План тестов
| AC | Уровень | Проверка |
|---|---|---|
| 1 | Скрипт | migrate на пустой БД дважды |
| 2 | Скрипт | изменение схемы без миграции → `db:check` красный |
| 3 | Ручная | `node dist/main.js migrate` в собранном приложении |
| 4 | Ручная | Чтение README модулей |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `pnpm db:migrate` применяет миграции из `apps/api/drizzle/` к пустой БД; повторный запуск ничего не меняет
- [ ] #2 `pnpm db:check` падает, если схема Drizzle изменена, а миграция не сгенерирована
- [ ] #3 Собранное приложение принимает команду `migrate` (используется в CD)
- [ ] #4 Соглашения ТД §4.1 (`uuidv7()`, `workspace_id` и составные ключи, `timestamptz`, деньги в minor units, `text + CHECK` вместо enum) описаны в README модулей с примером таблицы
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
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Подключить drizzle-orm и drizzle-kit в apps/api; в pnpm-workspace.yaml разрешить esbuild: false (pnpm 12 без этого не ставит зависимости).
2. Красные тесты с метками [SH-005 AC-n]: apps/api/src/platform/db/migrations.test.ts (AC-1, AC-2, AC-3, на TEST_DATABASE_URL) и apps/api/src/modules/readme.test.ts (AC-4). Отдельный коммит.
3. drizzle.config.ts: схема ./src/modules/*/db/schema.ts, выход ./drizzle, PostgreSQL, URL из DATABASE_URL.
4. Первая миграция drizzle/0000: CREATE EXTENSION IF NOT EXISTS pg_trgm (через drizzle-kit generate --custom).
5. platform/db: пул и runMigrations (drizzle-orm migrator). main.ts: аргумент migrate применяет миграции после проверки конфига и завершает процесс.
6. Скрипты в apps/api: db:generate (drizzle-kit generate), db:migrate (drizzle-kit migrate), db:check (scripts/db-check.mjs: drizzle-kit check и генерация во временной копии drizzle/; если появился новый файл, код 1).
7. apps/api/src/modules/README.md: соглашения ТД §4.1 и пример таблицы арендатора в комментарии.
8. Корневой README: команды db:migrate и db:check. ТД и ADR-0002 не меняются: решение то же.
9. Проверки: pnpm check, pnpm test, двойной запуск миграций, db:check на изменённой схеме (фикстура), запуск migrate в запущенном приложении.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч
Решение по ходу: "собранное приложение" в AC-3 понимаем как запуск исходников (node src/main.ts migrate): сборки в проекте пока нет, Dockerfile появится в SH-011. Это не меняет продуктового или архитектурного решения; отмечу в итоге.
<!-- SECTION:NOTES:END -->
