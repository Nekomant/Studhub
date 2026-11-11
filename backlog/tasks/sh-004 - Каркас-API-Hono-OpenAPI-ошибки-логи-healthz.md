---
id: SH-004
title: 'Каркас API: Hono, OpenAPI, ошибки, логи, healthz'
status: Review
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-11T15:13:00Z'
labels:
  - backend
milestone: m-0
dependencies:
  - SH-003
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Создать HTTP-приложение на Hono в `apps/api/src/main.ts` с префиксом `/api/v1`.
2. В `platform/` реализовать логгер pino с маскировкой полей ПДн, обработчик ошибок в формате `problem+json` с полем `code` и middleware заголовков безопасности (CSP, `frame-ancestors`).
3. Подключить `@hono/zod-openapi` и команду `pnpm gen:openapi`, которая пишет `apps/api/openapi.json`.
4. Реализовать `GET /healthz` с проверкой соединения с БД.
5. Создать пример структуры модуля `modules/<feature>/{domain,db,http}` с публичным `index.ts`.
6. До реализации написать тесты по критериям: юнит-тест маскировки логов и тесты HTTP через `app.request()` Hono в Vitest (после задачи харнесса API-тестов они переезжают в `tests/api`).

## Зачем
Общая обвязка сервера, на которую лягут все модули: единый формат ошибок, генерация контракта, логи без ПДн.

## Контекст
- ТД §2.2 (слои), §3 (сервер, логи), §6.1 (соглашения API), §9 (логи без ПДн, CSP), §13 (структура `apps/api`).

## Не входит
- Сессии и арендатор — этап 1.
- Фоновые задачи — задача «Фоновые задачи: pg-boss».

## Контракт
- `GET /healthz` → `200 {"status":"ok","db":"ok"}` | `503 problem+json`.

## План тестов
| AC | Уровень | Тест |
|---|---|---|
| 1 | API | healthz при доступной и недоступной БД |
| 2 | API | неизвестный маршрут, ошибка валидации, необработанное исключение → problem+json |
| 3 | Скрипт | `pnpm gen:openapi` создаёт валидный OpenAPI 3.1 |
| 4 | Юнит | маскировка полей ПДн в логгере |
| 5 | API | заголовки безопасности в ответе |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `GET /healthz` отвечает 200, когда БД доступна, и 503 в формате `problem+json`, когда нет
- [x] #2 Ошибка валидации, неизвестный маршрут и необработанное исключение возвращаются как `application/problem+json` с полями `type`, `title`, `status`, `code`; стек и внутренние детали в ответ не попадают
- [x] #3 `pnpm gen:openapi` генерирует спецификацию OpenAPI 3.1 из zod-схем маршрутов в `apps/api/openapi.json`; файл проходит валидацию
- [x] #4 Логи пишутся в JSON (pino); поля с ПДн (имя, телефон, email, telegram, тексты заметок, токены, cookie, заголовок Authorization) маскируются
- [x] #5 Ответы содержат заголовки безопасности из ТД §9: CSP с `default-src 'self'`, `frame-ancestors 'none'`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [ ] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [ ] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Ветка и окружение: Node 24 из .nvmrc, pnpm install.
2. Красные тесты по AC: apps/api/src/platform/logger (маскировка, AC-4), platform/errors (problem+json, AC-2), platform/security-headers (AC-5), /healthz при доступной и недоступной БД (AC-1, через app.request с подменой проверки БД), scripts/gen-openapi проверка OpenAPI 3.1 (AC-3).
3. Реализация: Hono-приложение apps/api/src/app.ts с префиксом /api/v1 (healthz на корне по ТД §6.2), platform/errors (problem+json с code, фолбэк 500 без стека), platform/logger (pino, redact ПДн), platform/security-headers (CSP default-src 'self', frame-ancestors 'none'), platform/db (pg Pool и ping SELECT 1), modules/health (пример модуля domain/db/http с index.ts), main.ts (старт сервера, порт из PORT, default 3000).
4. OpenAPI: @hono/zod-openapi, скрипт gen:openapi пишет apps/api/openapi.json (OpenAPI 3.1), проверка валидности.
5. Документы: README (раздел запуска API и gen:openapi), ТД не меняется, если поведение совпадает; ADR не нужен.
6. Проверки: pnpm check, pnpm test на чистом клоне ветки, проверка README-команд.
7. /code-review, исправления. Заметки, критерии --check-ac с доказательствами, итог, push, PR, статус Review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч
Решения по ходу: healthz на корне (/healthz, как в ТД §6.2 и мониторинге), остальные маршруты под /api/v1. Для проверки БД — драйвер pg (node-postgres), SH-005 подключит Drizzle поверх него; ADR не нужен, решение не меняет ТД/ADR.

Проверено: pnpm check (Biome, tsc) и pnpm test зелёные на чистом клоне ветки (127 тестов, 9 файлов). Живой прогон: API на Postgres 18 (docker compose, порт 5433): GET /healthz → 200 {"status":"ok","db":"ok"}; при неверном порту БД → 503 problem+json code db_unavailable без деталей подключения. Заголовки CSP и X-Content-Type-Options видны в живом ответе. Ревью /code-review (medium): исправлен нигде не вызываемый close(); замечание про Error в логах (стек с текстом ошибки проходит без маски) не исправлено — нужно решение владельца: маскировать текст ошибки или сохранить стек для отладки. Не сделано: DoD #2 (CI появится в SH-009), DoD #4 (эндпоинтов кабинета пока нет), DoD #6 (слияние). Решения: healthz на корне, остальное под /api/v1; драйвер pg для проверки БД (Drizzle придёт в SH-005, пул там будет отдельным); @hono/node-server для запуска; PORT читается в main.ts, а не в схеме конфигурации (чтобы не трогать .env.example, см. ниже); biome.json исключает generated openapi.json.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Сделано: каркас API на Hono в apps/api. GET /healthz (200 при доступной БД, 503 problem+json db_unavailable иначе) на корне; остальные маршруты под /api/v1. Ошибки (404, 400 валидации, 500) в формате application/problem+json с полем code, без стека и внутренних деталей. Логгер pino в JSON с рекурсивной маскировкой ПДн и секретов по именам полей. Заголовки безопасности: CSP default-src 'self', frame-ancestors 'none'. OpenAPI 3.1 из zod-схем, команда pnpm gen:openapi пишет apps/api/openapi.json; тест проверяет валидность и актуальность файла. Модуль-пример modules/health с domain/db/http и публичным index.ts. Проверки: 127 тестов и pnpm check зелёные на чистом клоне. Риски и хвосты: замечание ревью про маскировку Error в логах открыто, решение за владельцем; CI и изоляция кабинета (DoD 2 и 4) станут проверяемыми позже; .env.example не менялся (см. заметки).
<!-- SECTION:FINAL_SUMMARY:END -->
