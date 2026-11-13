---
id: SH-011
title: Docker-образ и деплой
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-13T18:23:00Z'
labels:
  - infra
milestone: m-0
dependencies:
  - SH-009
  - SH-010
priority: high
type: chore
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Написать multi-stage `Dockerfile`: сборка SPA и API, итоговый образ без dev-зависимостей, запуск не от root (раздача SPA — по ТД §2.1).
2. Добавить в GitHub Actions публикацию образа в GHCR с тегом SHA по слиянию в `main`.
3. Написать `infra/deploy.sh <tag>`: `migrate` → `pull` → `up -d` → проверка `/healthz`; job деплоя вызывает его по SSH.
4. Настроить секреты: GitHub Secrets для SSH и реестра, `.env` на сервере с правами 600.
5. Проверить полный цикл на тестовом PR и откат на предыдущий тег; результат записать в заметки.

## Зачем
Каждое слияние в `main` должно выкатываться в prod одной кнопкой (без ручных шагов), с возможностью отката.

## Контекст
- ТД §12 «CD», «Prod». ADR-0007.

## Контракт
Нет.

## План тестов
| AC | Уровень | Проверка |
|---|---|---|
| 1 | Ручная | `docker run` локально |
| 2 | Ручная | слияние тестового PR → prod |
| 3 | Ручная | откат на предыдущий тег |
| 4 | Ручная | `docker history`, права `.env` |
| 5 | Юнит | автотест на `ci.yml`: `tools/tests/docker-deploy.test.ts`, метка `[SH-011 AC-5]` |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Образ собирается одной командой, запускается от непривилегированного пользователя и отдаёт SPA и API
- [ ] #2 Слияние в `main` публикует образ с тегом SHA в GHCR и выкатывает его в prod: миграции → обновление → проверка `/healthz`; при неудачной проверке job красный
- [ ] #3 `infra/deploy.sh <tag>` выкатывает указанный предыдущий тег (откат проверен в prod)
- [ ] #4 Секреты не попадают в образ и репозиторий: они в GitHub Secrets и в `.env` на сервере с правами 600
- [x] #5 В CI добавлена сборка образа без публикации на каждый PR (workflow создаёт SH-009)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [x] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [ ] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. SPA раздаёт процесс app (ответ владельца): serveStatic из WEB_ROOT, запасной index.html вне /api, /healthz, /ical, /__test. Правка ТД §2.1 и §12.
2. Dockerfile (multi-stage, pnpm deploy --prod, USER node) и .dockerignore; проверка docker run локально.
3. infra/deploy.sh <tag>: migrate, pull, up -d, проверка /healthz, код 1 при неудаче. docker-compose.prod.yml без профиля app, Caddyfile проксирует /healthz на app, .env.prod.example получает S3-переменные.
4. ci.yml: job image (сборка на PR без публикации, публикация в GHCR с тегом SHA по push в main), job deploy (scp файлов infra и ssh deploy.sh).
5. Тесты по критериям: tools/tests/docker-deploy.test.ts (Dockerfile, CI, deploy.sh с подменой docker и curl), apps/api/src/spa.test.ts.
6. Ручные проверки: docker run, docker history; GitHub Secrets, .env на сервере, прогон на prod и откат делает владелец (точки СТОП).
7. Документы: ТД §2.1, §12, infra/README.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч

Решение: SPA раздаёт процесс app (ответ владельца, вариант А). ТД §2.1 и §12 исправлены.

Решение: ENTRYPOINT [node, src/main.ts] вместо CMD, чтобы docker compose run --rm app migrate передавал migrate аргументом. Регулярное выражение в тесте было неверным (искало CMD); критерии не менялись.

Решение: образ в GHCR пушит GITHUB_TOKEN, сервер тянет образ по docker login с токеном read:packages (один раз, вручную). Секреты GitHub: DEPLOY_SSH_KEY, DEPLOY_HOST, DEPLOY_USER, DEPLOY_KNOWN_HOSTS.

Решение: deploy.sh передаёт тег в compose переменной окружения, а APP_TAG в .env записывает после успешного up -d. Автоотката нет: при красной проверке скрипт печатает команду отката.

Факт AC-1 (локально): docker build ok, 279 МБ; docker run от uid 1000 (node), /healthz 200 db ok, / и /students/1 отдают index.html, /api/v1/nope 404 problem+json, healthcheck healthy; migrate применил миграции. В docker history нет секретов, .env в образе нет, vitest/biome/typescript/drizzle-kit в node_modules нет.

Факт: actionlint и shellcheck на ci.yml и deploy.sh без замечаний; caddy validate по новому Caddyfile: Valid configuration.

Ждёт владельца: (1) docker login ghcr.io на сервере с токеном read:packages; (2) четыре секрета GitHub DEPLOY_SSH_KEY, DEPLOY_HOST, DEPLOY_USER, DEPLOY_KNOWN_HOSTS; (3) .env на сервере (права 600) с пятью S3-заглушками; (4) прогон тестового PR и откат на предыдущий тег (AC-2, AC-3, часть AC-4). Порядок: infra/README.md шаги 7, 10, 11.

Факт: 6 ч (без прогона на prod)

Не проверено без слияния: AC-2 (первый деплой по слиянию в main), AC-3 (откат на предыдущий тег), часть AC-4 (права 600 на сервере владелец подтвердил словами, вывод stat не получен).

Замечание 1: исправлено, в «План тестов» добавлена строка для AC-5.

Замечание 2: образы старых тегов копятся на диске prod (около 30 МБ уникальных слоёв на выкладку), автоочистки нет, ручная команда prune в infra/README.md. Грозит заполнением диска через долгое время. Можно добавить очистку в SH-012.

Замечание 3: apps/api/src/db/migrations.test.ts ([SH-005 AC-1]) упал по таймауту 10 с под нагрузкой параллельной docker build, отдельно проходит за 8 с. Грозит нестабильным CI на медленном раннере.

Замечание 4: deploy.sh не откатывается сам при красной проверке /healthz, а печатает команду отката (так требует критерий «job красный»). Грозит простоем до ручного отката.

Решение владельца по замечанию 2: автоочистку старых образов на prod делаем в SH-012. Штабу: добавить в спецификацию SH-012 (pnpm remarks).

Проверка sh-verifier: AC-5 подтверждён (tools/tests/docker-deploy.test.ts). AC-1..AC-4 по плану ручные; AC-2, AC-3, AC-4 проверяются после слияния в main на prod. Тест AC-1 после красного коммита поправлен (CMD→ENTRYPOINT, WEB_ROOT в многострочном ENV), критерии не менялись, нарушением не считается.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Сделано: процесс app раздаёт собранную SPA (WEB_ROOT, apps/api/src/platform/spa); Dockerfile (multi-stage, pnpm deploy --prod, USER node, HEALTHCHECK) и .dockerignore; infra/deploy.sh <тег> (migrate, pull app, up -d, caddy reload, проверка /healthz с повторами, код 1 при неудаче, отказ при правах .env шире 600); prod-compose без профиля app; Caddyfile проксирует всё на app; job image (сборка на PR, публикация в GHCR с тегом SHA по push в main) и job deploy (scp файлов infra и ssh deploy.sh) в ci.yml. Проверено: pnpm verify зелёный (974 теста), docker build и docker run локально (uid 1000, /healthz, SPA, problem+json, healthy), actionlint, shellcheck, caddy validate. Документы: ТД §2.1 и §12, ADR-0007, infra/README.md. Осталось после слияния: первый деплой, второй тестовый PR, откат.
<!-- SECTION:FINAL_SUMMARY:END -->
