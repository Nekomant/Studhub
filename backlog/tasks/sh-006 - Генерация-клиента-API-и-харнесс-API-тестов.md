---
id: SH-006
title: Генерация клиента API и харнесс API-тестов
status: Review
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-12T23:08:00Z'
labels:
  - backend
  - frontend
milestone: m-0
dependencies:
  - SH-005
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. В `packages/client-core` подключить `openapi-typescript` и `openapi-fetch`, добавить `pnpm gen:client` и проверку актуальности (сгенерировать заново и сравнить с закоммиченным).
2. Ввести в сервере единый источник времени `clock.now()` и использовать его вместо `Date.now()`.
3. Добавить тестовый маршрут `POST /__test/clock`, который регистрируется только при `APP_MODE=test`.
4. Собрать харнесс `tests/api`: глобальная подготовка (тестовая БД, миграции, запуск приложения), фабрика клиента, изоляция данных между тестами, параллельный запуск по файлам.
5. Перенести в `tests/api` HTTP-тесты из задачи каркаса API и написать тесты по критериям этой задачи.
6. Добавить правило Biome, запрещающее импорт `apps/api` из `tests/api`.

## Зачем
Клиент и тесты знают о сервере только через OpenAPI (ТД §1). API-тесты — чёрный ящик на реальном Postgres. Без харнесса тесты по критериям приёмки писать не на чем.

## Контекст
- ТД §2.2, §3 (контракт клиента), §14 (уровни тестов).
- `docs/process.md` §8 (именование, управляемое время).

## Не входит
CI — задача «CI в GitHub Actions».

## Контракт
Тестовый маршрут `POST /__test/clock` регистрируется только при `APP_MODE=test`.

## План тестов
| AC | Уровень | Тест |
|---|---|---|
| 1 | Скрипт | изменение `openapi.json` без генерации → проверка красная |
| 2 | API | healthz через сгенерированный клиент |
| 3 | API | два теста меняют данные, не мешая друг другу |
| 4 | API | установка часов в тестовом режиме; маршрут отсутствует без тестового режима |
| 5 | Фикстура | импорт `apps/api` из `tests/api` → ошибка Biome |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `pnpm gen:client` генерирует типизированный клиент в `packages/client-core` из `openapi.json`; проверка актуальности падает, если `openapi.json` изменён без перегенерации
- [x] #2 `pnpm test:api` поднимает приложение на тестовой БД с миграциями и выполняет тесты из `tests/api` через сгенерированный клиент
- [x] #3 Тесты изолированы по данным и могут выполняться параллельно по файлам
- [x] #4 В тестовом режиме тест может установить текущее время сервера; без тестового режима маршрут управления временем не регистрируется
- [x] #5 Импорт кода `apps/api` из `tests/api` запрещён правилом Biome
- [x] #6 В CI добавлены шаги проверки актуальности клиента OpenAPI и `pnpm test:api` (workflow создаёт SH-009)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [x] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [ ] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Часы сервера: platform/clock (системные и управляемые), clock вместо Date.now(); в AppDeps добавить clock и testMode; APP_MODE в конфиг и .env.example.
2. Тестовые маршруты POST/GET /__test/clock в обычном Hono (не попадают в openapi.json), регистрируются только в тестовом режиме.
3. client-core: scripts/gen-client.mjs (openapi-typescript, режим --check), src/api/schema.ts, createApiClient на openapi-fetch; pnpm gen:client и gen:client:check.
4. tests/api: globalSetup создаёт шаблонную БД и применяет миграции командой migrate; фабрика startTestApp клонирует БД из шаблона на каждый тестовый файл, запускает приложение дочерним процессом на свободном порту и отдаёт клиент; pnpm test:api.
5. Перенести HTTP-тесты каркаса (healthz, problem+json, заголовки) из apps/api/src/app.test.ts в tests/api; в app.test.ts оставить то, что требует кода сервера.
6. Фикстура Biome для tests/api (относительный импорт apps/api) и добавить в boundaries.test.ts.
7. Шаги gen:client:check и test:api в ci.yml плюс тест на ci.yml.
8. Документы: ТД §12/§14, README, process §8.3.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч

Решение: тестовые маршруты /__test/* сделаны на обычном Hono без zod-openapi, поэтому их нет в openapi.json и в клиенте. Добавлен GET /__test/clock: без него тест не может прочитать время сервера. POST принимает {now: ISO} или {now: null} (вернуть системное время).
Решение: переменная APP_MODE (только значение test) добавлена в схему конфигурации и .env.example. Пустое значение считается незаданным.
Решение: изоляция данных. globalSetup создаёт шаблонную БД <stem>_api_template_<hex>_test и применяет миграции командой main.ts migrate. Каждый тестовый файл копирует шаблон, запускает приложение процессом на свободном порту и удаляет свою БД в stop(). Это не затрагивает БД из TEST_DATABASE_URL, на которой работает apps/api/src/db/migrations.test.ts, и параллельные запуски в разных worktree не пересекаются.
Решение: клиент OpenAPI лежит в packages/client-core/src/api/schema.ts, генерируется openapi-typescript через API (gen-client.mjs), файл исключён из Biome. openapi-typescript 7.13 заявляет peer typescript ^5, а в репозитории TypeScript 6.0.3: генерация и tsc -b работают, предупреждение pnpm peers check остаётся.
Решение: в CI шаг pnpm test пропускает проект API-тестов (--project '!@studhub/tests-api'), чтобы они не шли дважды; pnpm verify и локальный pnpm test запускают все проекты.
Решение: из app.test.ts в tests/api перенесены healthz 200 и 503, 404 и CSP (503 проверяется приложением с недоступной БД). В app.test.ts остались тесты через extraRoutes (валидация, 500): им нужен код сервера.
Факт: около 1,5 ч

Проверка sh-verifier: все 6 критериев подтверждены тестами, тесты после красного коммита 100e543 не ослаблены (в config.test.ts добавлен один тест AC-4). pnpm test:api хук не пропустил, tests/api прогнаны через vitest --root tests/api, 16 тестов зелёные.

Правки по ревью (решения владельца): 1) конфигурация отклоняет APP_MODE=test при NODE_ENV=production, тест [SH-006 AC-4] в config.test.ts; 2) test-app.ts без приведения as string; 3) app-process.ts: готовность по строке лога «API запущен» с нужным портом, до 3 попыток запуска с новым портом; 4) дочерний процесс получает явный список переменных (PATH, HOME, TMPDIR, LANG, TZ). pnpm verify: 844 теста зелёные.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Добавлены: генерация клиента OpenAPI (pnpm gen:client, gen:client:check, createApiClient на openapi-fetch в client-core); часы сервера platform/clock и тестовые маршруты GET и POST /__test/clock, которые регистрируются только при APP_MODE=test; харнесс tests/api (шаблонная БД с миграциями, приложение процессом на каждый файл, параллельный запуск, pnpm test:api); шаги gen:client:check и test:api в CI. HTTP-тесты каркаса перенесены в tests/api. Проверено: pnpm verify зелёный (843 теста), каждый критерий покрыт тестом с меткой SH-006 AC-n. Документы: README, ТД §6.1 и §14, process §8.3 и §9, .env.example.
<!-- SECTION:FINAL_SUMMARY:END -->
