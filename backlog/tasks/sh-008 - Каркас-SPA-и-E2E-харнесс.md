---
id: SH-008
title: Каркас SPA и E2E-харнесс
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-13T00:23:00Z'
labels:
  - frontend
  - pwa
milestone: m-0
dependencies:
  - SH-006
  - SH-073
documentation:
  - docs/design-system.md
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Создать `apps/web` на Vite + React 19 + TypeScript.
2. Подключить Tailwind CSS v4, shadcn/ui и иконки lucide на токенах и шрифтах из `packages/ui-tokens` (SH-073, `design-system.md`).
3. Подключить TanStack Router (карта маршрутов в `client-core`) и TanStack Query; завести маршруты пяти вкладок по `screens.md` §3.2 с заглушками.
4. Сделать оболочку: нижняя панель при ширине меньше 768 px, боковая — при большей.
5. Настроить `pnpm dev` (SPA + API, прокси `/api`) и вывести на заглушке статус `/healthz` через сгенерированный клиент.
6. Подключить vite-plugin-pwa: manifest и service worker, кэширующий только статику.
7. Настроить Playwright в `tests/e2e` и написать тесты по критериям, включая проверку отсутствия запросов к внешним доменам.

## Зачем
Оболочка приложения, на которую будут добавляться экраны, и инструмент для E2E-тестов сценариев.

## Контекст
- ТД §2.2, §3 (клиент, UI, PWA), §8 (слои клиента), §9 (без внешних CDN).
- `docs/design-system.md`: §7 навигация (нижняя и боковая панель), §8 соответствие shadcn/ui.
- `docs/screens.md` §3.1 (вкладки), §3.2 (адреса).

## Не входит
Экраны входа — этап 1. Установка PWA и офлайн — этап 7.

## Контракт
Нет.

## План тестов
| AC | Уровень | Тест |
|---|---|---|
| 1 | E2E | заглушка показывает статус `/healthz` |
| 2 | E2E | вкладки на 375 и 1280 px |
| 3 | E2E | нет запросов к внешним доменам |
| 4 | E2E | smoke-тест |
| 5 | E2E | manifest и регистрация service worker |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `pnpm dev` запускает SPA и API; SPA обращается к API через прокси `/api` сгенерированным клиентом (заглушка показывает статус `/healthz`)
- [x] #2 Оболочка: при ширине меньше 768 px — нижняя панель, при большей — боковая; пять вкладок и адреса по `screens.md` §3.1–3.2 с заглушками
- [x] #3 Приложение не обращается к внешним доменам (шрифты, иконки, CDN) — проверено в E2E по сетевым запросам
- [x] #4 `pnpm test:e2e` запускает Playwright против собранного приложения; smoke-тест находит элементы по ролям и текстам
- [x] #5 Приложение отдаёт web manifest и регистрирует service worker, который кэширует только статику
- [x] #6 В CI добавлен шаг Playwright E2E с кэшем браузеров (workflow создаёт SH-009)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [x] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [x] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Красные тесты: E2E Playwright в tests/e2e (AC-1…5), юнит-тесты client-core (карта маршрутов, запрос healthz), проверка шага CI (AC-6) в tools/tests/ci-workflow.test.ts. Отдельный коммит.
2. client-core: карта маршрутов (пять вкладок и пункты боковой панели по screens.md §3.1–3.2), фабрика запроса /healthz.
3. apps/web: Vite, React 19, Tailwind v4 на ui-tokens, shadcn/ui (components.json, cn), lucide, TanStack Router и Query, оболочка (нижняя панель меньше 768 px, боковая от 768 px), заглушки экранов, статус /healthz на «Сегодня».
4. vite-plugin-pwa: manifest, service worker только со статикой (registerType prompt), без кэша /api и /healthz.
5. Прокси /api и /healthz на API в dev и preview, pnpm dev запускает SPA и API.
6. tests/e2e: Playwright, скрипт стека (БД, миграции, API, vite preview), pnpm test:e2e собирает SPA и запускает тесты.
7. CI: шаг E2E с кэшем браузеров Playwright.
8. Документы: README (команды dev и test:e2e), docs/process.md §9 (шаг CI), ТД §14 при необходимости.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 8 ч

Решения по ходу работы:
- Адреса и подписи вкладок живут в packages/client-core (routes.ts): mobileTabs, desktopNav, appRoutes. apps/web только рисует их.
- Запрос /healthz описан в client-core как обычный объект queryKey/queryFn (health.ts), без @tanstack/query-core: useQuery принимает его напрямую.
- Прокси /api и /healthz настроен в server.proxy и preview.proxy Vite; цель задаёт API_PROXY_TARGET (по умолчанию http://127.0.0.1:3000). Клиент ходит на window.location.origin.
- pnpm dev (scripts/dev.mjs) запускает pnpm --filter dev у API (node --watch) и у SPA. Проверено вручную: :5173/healthz проксируется на API и отдаёт {status:ok,db:ok}; Ctrl+C гасит оба процесса. E2E dev-режим не проверяет: AC-1 тестируется на сборке через тот же прокси в vite preview.
- vite-plugin-pwa: generateSW, registerType prompt, injectRegister false, precache только js/css/html/woff2/svg/png/ico/webmanifest; navigateFallback /index.html, но не для /api, /healthz, /ical, /__test. Кэша данных нет.
- E2E стек (tests/e2e/src/support/stack.ts): отдельная БД рядом с TEST_DATABASE_URL, миграции, API и vite preview на свободных портах; Playwright запускает его через webServer.
- Боковая панель: сам nav является панелью (fixed, x=0, на всю высоту), бренд внутри nav. Тест AC-2 измеряет box nav, поэтому структура aside > nav не подходила.
- CI: шаг actions/cache@v5 (~/.cache/ms-playwright, ключ по hashFiles('pnpm-lock.yaml')) перед установкой Chromium и шаг pnpm test:e2e в конце. Версия Playwright одна (1.65.0) в ui-tokens и tests/e2e, поэтому один кэш подходит обоим.
- Тесты не ослаблялись после красного коммита.
- pnpm verify под нагрузкой машины (load average около 8–10) дважды падал по таймауту 5 с в тестах других задач, которые запускают pnpm (SH-005 migrations.test.ts, SH-091 close-task.test.ts). Каждый тест проходит отдельно, полный vitest run с --maxWorkers=3 даёт 884 из 884. Не связано с SH-008, но таймаут хрупкий.
Факт: ≈0,5 ч по времени коммитов (оценка была 8 ч).

Дополнение по замечанию sh-verifier к AC-1: добавлены tests/e2e/src/dev.spec.ts (запускает pnpm dev на свободных портах и отдельной БД: API отвечает, dev-сервер SPA отдаёт исходники, /api/v1 проксируется и отдаёт problem+json not_found от API, заглушка показывает статус /healthz, SIGINT гасит оба процесса) и proxy.spec.ts (прокси /api в vite preview, SPA запрашивает /healthz на своём адресе). Тесты добавлены после реализации; мутация «убрать /api из прокси» ломает оба. Для теста dev-сервер читает WEB_PORT (strictPort, если задан). Тесты красного коммита не менялись.

Проверка sh-verifier (повторная, HEAD a9927cd): AC-1..AC-6 подтверждены; нарушений правила тестов нет. Первая проверка: AC-1 сомнительно (pnpm dev и прокси /api не покрыты), по ответу владельца дописаны тесты dev.spec.ts и proxy.spec.ts. pnpm verify падает по таймауту 5 с в SH-005 migrations.test.ts под нагрузкой; решение владельца: смотреть CI на PR.

Правки по /code-review: (1) scripts/dev.mjs выходит с кодом первого упавшего процесса (code || 1), 0 после Ctrl+C; node --watch держит API после ошибки конфигурации, поэтому тест выхода использует занятый WEB_PORT (strictPort, Vite завершается с кодом 1). (2) WEB_PORT проверяется: целое 1–65535, иначе ошибка с понятным текстом. (3) Комментарии про prompt приведены к факту: onNeedRefresh нет, баннер добавит этап 7. (4) start_url берётся из startPath client-core. (5) freePort: повтор запуска API (stack.ts) и pnpm dev (dev.spec.ts) до 3 попыток, если процесс завершился сразу. (6) tsconfig web разделён: tsconfig.app.json без Node-типов и tsconfig.node.json для vite.config.ts.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Добавлены apps/web (Vite, React 19, Tailwind v4 на токенах, shadcn/ui, lucide, TanStack Router и Query), оболочка с нижней и боковой панелью, пять вкладок и заглушки по screens.md §3.2, статус /healthz через сгенерированный клиент, PWA со статикой. client-core хранит карту маршрутов и запрос healthz. pnpm dev запускает API и SPA, pnpm test:e2e собирает SPA и запускает Playwright (15 тестов). В CI добавлены кэш браузеров и шаг E2E. README и docs/process.md обновлены.
<!-- SECTION:FINAL_SUMMARY:END -->
