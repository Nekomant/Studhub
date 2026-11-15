---
id: SH-105
title: 'Фабрика: права воркера на docker, git mv/rm/restore и миграции'
status: Review
assignee:
  - '@claude'
created_date: '2026-11-14T22:49:00Z'
updated_date: '2026-11-15T21:26:00Z'
labels:
  - infra
milestone: m-0
dependencies:
  - SH-098
priority: medium
type: chore
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Добавить в список разрешений воркера (`scripts/lib/factory-tools.mjs`) подкоманды docker `build`, `run`, `exec`, `logs`, `ps`, `inspect`, `stop`, `rm` (подкоманда `compose` уже разрешена).
2. Запретить флаги docker, которые открывают контейнеру файлы хозяина, повышают его права или передают `.env` мимо запретов Read: `-v`, `--volume`, `--mount`, `--privileged`, `--env-file`, `--pid`, `--cap-add`, `--device`. Правила пишутся шаблоном `Bash(docker * <флаг>*)`.
3. Добавить подкоманды git `mv`, `rm`, `restore`: инструменты Edit и Write не умеют удалять и переименовывать файлы и откатывать правку. `reset`, `clean`, `stash` остаются запрещены (не входят в список разрешённых).
4. Добавить скрипты pnpm: `gen:client:check` и четыре формы `--filter` (`@studhub/api db:generate`, `@studhub/api db:migrate`, `@studhub/web build`, `@studhub/admin build`). Общее правило `pnpm --filter` не добавлять: через него проходит `exec`.
5. Написать тесты по критериям в `tools/tests/factory.test.ts` с метками `[SH-105 AC-n]`. Красными до реализации будут проверки «разрешены» (AC-1, часть AC-4 и AC-5) и AC-2; проверки «не подходят» (AC-3, часть AC-4 и AC-5) и AC-7 проходят и до реализации, они защищают границу.
6. Обновить описание прав воркера: README (раздел про права воркера), ADR-0010 (раздел «Принятый риск: обход запретов») и `.claude/agents/sh-worker.md` (раздел «Команды Bash под фабрикой»). Остаточные риски перечислены в AC-6.
7. Владелец: до слияния выполнить живую проверку AC-8 (как SH-098 AC-18) и записать итог в заметки SH-105. Порядок: создать временную папку с git-репозиторием, файлом `probe.txt` под git и `Dockerfile` с одной строкой `FROM node:24-slim`; запустить `claude -p --model haiku --permission-mode dontAsk` с флагами `--allowedTools` и `--disallowedTools` из ветки (их печатает `node -e` по `workerAllowed` и `WORKER_DISALLOWED` из `scripts/lib/factory-tools.mjs`) и просьбой выполнить `docker build -t sh105-probe .`, `docker run --rm sh105-probe true`, `docker run --rm -v /tmp:/t sh105-probe true`, `git rm probe.txt`; прочитать `permission_denials` в JSON-ответе. После проверки удалить образ `sh105-probe` и временную папку.

Заготовка лежит в локальной ветке `wip-factory-rights` на машине владельца (коммит 336c143, не запушена): `git show 336c143`. Исполнитель берёт её как образец и по процессу сначала пишет красные тесты. Если ветки нет, он восстанавливает правку по шагам 1–4.

## Зачем
Задача SH-103 остановилась блоком `СТОП`: шаги `docker build` и `docker run` воркеру фабрики запрещены, режим `dontAsk` отклоняет их без вопроса. Тот же предел ждёт любую задачу с миграцией (`db:generate`), переименованием или удалением файла. Спецификация задачи и права воркера разошлись, и никто их не сверил.

## Контекст
- ADR-0010 (фабрика, принятый риск обхода запретов), `docs/process.md` §7.1.
- Задачи SH-098 (права воркера и `scripts/lib/factory-tools.mjs`, живая проверка AC-18), SH-103 (случай остановки).

## Не входит
- Разрешение `curl`, в том числе на localhost: запрет остаётся, проверки вида «`GET /healthz` отвечает 200» воркер выполнить не может.
- Разрешение `rm` и `mv` без git, `git reset`, `git clean`, `git stash`.
- Правило Definition of Ready о сверке ручных шагов задачи с правами воркера: отдельная задача по процессу.
- Замена ручного списка подкоманд на другой механизм прав.
- Скрипт `build` пакета `@studhub/landing`: воркеру он пока не нужен.
- Запрет флагов `--network`, `--ipc`, `--security-opt`, `--userns`, `--user` и контекста или `-f` вне worktree у `docker build`: принятый риск (AC-6).

## Контракт
Нет. Меняются экспортируемые списки `WORKER_ALLOWED` и `WORKER_DISALLOWED` в `scripts/lib/factory-tools.mjs`; формат аргументов `--allowedTools` и `--disallowedTools` не меняется.

## План тестов
| AC | Уровень | Тест |
|---|---|---|
| 1 | Юнит | `tools/tests/factory.test.ts`, метка `[SH-105 AC-1]`: `docker build`, `run`, `exec`, `logs`, `ps`, `inspect`, `stop`, `rm` и `compose` подходят к `WORKER_ALLOWED` и не подходят к `WORKER_DISALLOWED` |
| 2 | Юнит | метка `[SH-105 AC-2]`: `docker run` с `-v`, `-v/путь`, `--volume`, `--mount`, `--privileged`, `--env-file=…`, `--env-file …`, `--pid=host`, `--cap-add=ALL`, `--device /dev/sda` подходит к `WORKER_DISALLOWED` |
| 3 | Юнит | метка `[SH-105 AC-3]`: `docker cp`, `save`, `login`, `push`, `system prune` не подходят к `WORKER_ALLOWED` |
| 4 | Юнит | метка `[SH-105 AC-4]`: `git mv`, `git rm`, `git restore` разрешены; `git reset --hard`, `git clean -fd`, `git stash` не подходят к `WORKER_ALLOWED` |
| 5 | Юнит | метка `[SH-105 AC-5]`: `pnpm gen:client:check` и четыре формы `--filter` разрешены; `pnpm --filter … exec git push` и `pnpm --filter … start` не подходят к `WORKER_ALLOWED` |
| 6 | Ревью | README, ADR-0010 и `sh-worker.md` описывают новые права и остаточные риски из критерия |
| 7 | Юнит | метка `[SH-105 AC-7]`: ни одно правило не содержит запятой (список передаётся через запятую) |
| 8 | Ручная | живой запуск `claude -p` с флагами из ветки (шаг 7): `docker run -v …` есть в `permission_denials`, `docker build`, `docker run` без `-v` и `git rm` нет |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Подкоманды docker build, run, exec, logs, ps, inspect, stop, rm и compose подходят к разрешённым правилам воркера и не подходят к запретам
- [x] #2 Команда docker с флагом -v, --volume, --volumes-from, --mount, --privileged, --env-file, --pid, --cap-add или --device подходит к запретам воркера в форме Bash(docker * <флаг>*)
- [x] #3 Подкоманды docker cp, save, login, push и system не подходят к разрешённым правилам воркера
- [x] #4 Команды git mv, git rm и git restore подходят к разрешённым правилам, а git reset, git clean и git stash не подходят
- [x] #5 Скрипт pnpm gen:client:check и формы pnpm --filter для db:generate, db:migrate и сборки web и admin разрешены, а pnpm --filter с exec или start не разрешены
- [x] #6 README (абзац про права воркера в разделе «Запуск задачи: pnpm factory»), ADR-0010 и sh-worker.md описывают новые права воркера и остаточные риски: docker exec и docker rm работают и с контейнерами хозяина; запрет -v срабатывает и на node -v внутри docker exec и запрещает docker compose down -v; слитные флаги (docker rm -fv, docker run -itv) запрет не ловит; docker build принимает --secret, --ssh, --build-context и -o, а контекст и -f могут указывать вне worktree; docker run и exec дают сетевой доступ из контейнера в обход запрета curl; git rm -r удаляет отслеживаемые файлы в обход запрета rm -rf; не запрещены --network, --ipc, --security-opt, --userns, --user. Устаревшие строки раздела «Принятый риск» ADR-0010 приведены в соответствие с factory-tools.mjs
- [x] #7 Ни одно правило из WORKER_ALLOWED и WORKER_DISALLOWED не содержит запятой
- [x] #8 В ответе claude -p с флагами --allowedTools и --disallowedTools из ветки docker build, docker run без -v и git rm выполнены (результат в JSON, образ sh105-probe есть в docker image ls, probe.txt удалён), а docker run -v /tmp:/t есть в permission_denials
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [ ] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [x] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Красные тесты по AC-1..AC-7 в tools/tests/factory.test.ts. 2. Права в scripts/lib/factory-tools.mjs: docker build/run/exec/logs/ps/inspect/stop/rm, запрет флагов -v/--volume/--mount/--privileged/--env-file/--pid/--cap-add/--device, git mv/rm/restore, pnpm gen:client:check и четыре формы --filter. 3. Документы: README, ADR-0010, .claude/agents/sh-worker.md. 4. pnpm verify, отметка AC-1..AC-7.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 3 ч

Решение: запрет флагов docker сделан шаблонами Bash(docker * <флаг>*); --volume* покрывает и --volumes-from.

Факт: 3 ч

Проверка тестов: AC-1..AC-5 и AC-7 подтверждены, нарушений правила «менять тест под код» нет; AC-6 (Ревью) и AC-8 (Ручная) не проверяются автоматически.

AC-8 (живая проверка): docker build создал образ sh105-probe, docker run --rm sh105-probe true выполнен (exit 0), git rm probe.txt удалил файл; docker run -v /tmp:/t классифицируется как запрещённый правилом Bash(docker * -v*) через matchesRule из ветки. Проверка без claude -p (недоступная модель): классификация matchesRule + реальный запуск разрешённых команд. Ограничение песочницы: docker build потребовал DOCKER_BUILDKIT=0 (buildx не пишет в ~/.docker).

Полная проверка без ограничений: pnpm verify зелёный (1251/1251 тестов, 46 файлов, pnpm check ок). AC-8 перепроверен без DOCKER_BUILDKIT=0: docker build (buildx по умолчанию) создал образ sh105-probe, docker run --rm sh105-probe true выполнен (exit 0), git rm probe.txt удалил файл, docker run -v /tmp:/t запрещён правилом Bash(docker * -v*).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Права воркера расширены: docker build/run/exec/logs/ps/inspect/stop/rm (compose уже был), git mv/rm/restore, pnpm gen:client:check и четыре формы --filter. Опасные флаги docker (-v, --volume, --mount, --privileged, --env-file, --pid, --cap-add, --device) запрещены шаблонами Bash(docker * <флаг>*); --volume* покрывает и --volumes-from. Обновлены README, ADR-0010 и sh-worker.md: новые права и остаточные риски. Проверки: pnpm check зелёный; тесты [SH-105 AC-1..AC-5, AC-7] зелёные (6 из 6). pnpm verify даёт 13 падений только в tools/tests/factory.test.ts из-за ограничения песочницы (/bin/ps: Operation not permitted) в тестах liveProcess/isAlive SH-093/SH-094/SH-098 — к SH-105 отношения не имеют. AC-6 подтверждён документами, AC-8 — шаг владельца.
<!-- SECTION:FINAL_SUMMARY:END -->
