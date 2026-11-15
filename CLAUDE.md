# Studhub

Веб-приложение (PWA) для частных репетиторов: ученики, расписание, оплаты, контекст уроков, материалы. Рынок РФ/СНГ, интерфейс на русском. Общение с владельцем — по-русски.

## Документы (источник истины)

- `docs/product-concept.md` — зачем и что. `docs/use-cases.md` — сценарии UC-xx. `docs/screens.md` — экраны. `docs/design-system.md` — внешний вид: токены, шрифты, компоненты.
- `docs/technical-design.md` (ТД) — модель, правила, API, архитектура, стек. `docs/adr/` — решения.
- `docs/process.md` — **процесс разработки, обязателен к прочтению перед работой над задачей.**

При противоречии главнее документ выше по этому списку. Противоречие не решаем молча — спрашиваем владельца.

## Правила работы над задачей

1. Работаем только по задаче из Backlog.md в статусе **Ready**. Нет задачи или она не Ready — сначала спецификация и согласование.
2. Одна задача — одна сессия — отдельная ветка `sh-NNN-slug` в worktree — один PR.
3. Задача проходит статусы **Backlog → Ready → Merged → Done**. Порядок: план в задачу → **красные тесты по критериям приёмки** (отдельный коммит) → реализация → правка документов → проверки → ревью `sh-reviewer` → PR → добро владельца → `factory merge` (статус Merged) → выкладка в prod (статус Done).
4. Каждый тест по критерию начинается с метки `[SH-NNN AC-n]`. Менять тест под код без изменения критерия нельзя.
5. Работа вне критериев приёмки — стоп, спросить владельца.
6. Поведение или решение изменилось — правим `docs/` в том же PR; новое архитектурное решение — ADR.

## Жёсткие правила кода

Жёсткие правила кода (ТД §1, §13) вынесены в скилл `sh-code-rules` (`.claude/skills/sh-code-rules/SKILL.md`): его подключают воркер и ревьюер через поле `skills:`. Здесь остаётся только ссылка; подробности — в скилле и в ТД §1 и §13.

## Фабрика и воркер

- Задачу ведёт фабрика — локальный скрипт `pnpm factory` ([README.md](README.md#запуск-задачи-pnpm-factory), ADR-0011) без модели. Команды: `factory ready` (выбор и проверка задачи, ветка, worktree, права, бриф), `factory next` (проверки DoD, ревьюер, push, PR, CI), `factory merge` (после добра владельца: ретро, статус Merged, слияние, уборка), `factory status` (текущий этап). Запасной вариант — `factory run` с фоновым воркером и команды `answer`/`continue`/`drop` ([README.md](README.md#запуск-задачи-pnpm-factory)).
- Воркер `sh-worker` — основной агент подсессии задачи. Он не проверяет статус и Definition of Ready, не меняет статусы, не делает push, PR и слияние; пишет тесты и код по спецификации и вызывает `factory next`. Вопросы владельцу он задаёт в своей подсессии и записывает в журнал фабрики. Подробно: `docs/process.md` §7.1.
- Ревьюер `sh-reviewer` запускается фабрикой отдельным процессом (`deepseek-v4-pro`, `max`, только чтение); ретро ведёт `sh-retro` (`deepseek-flash`, только чтение) в `factory merge`.
- Старт задач ручной: `/ready` и команды фабрики — только по прямой команде владельца; хуки, расписания, скрипты и циклы автоматического старта не добавляем (`docs/process.md` §7). /ready — прямая команда владельца.
- Задача: `node scripts/task.mjs SH-NNN` вместо `backlog task view`. Документы по разделам: `node scripts/doc.mjs td 4.1`, `uc UC-01`, `screens Э-01`; ТД, `use-cases.md` и `screens.md` целиком не читаем. Проверки: `pnpm verify`.
- Локальные переменные окружения берутся из `.env` основной папки хуком SessionStart, только из списка в `scripts/lib/local-env.mjs` (его использует и фабрика): `POSTGRES_PORT`, `DATABASE_URL`, `TEST_DATABASE_URL`. `.env` агент не создаёт и не читает.

## Штаб, спецификации и основная папка

- Спецификации штаб пишет в своём worktree, в ветке `specs-…`, и открывает PR «Спецификации: SH-…». Задачи к работе в PR уже в Ready; слияние PR владельцем означает согласование.
- Порядок старта: владелец запускает `/ready SH-NNN` в корневой сессии; корневая сессия вызывает `factory ready`, а фабрика создаёт ветку `sh-NNN-<slug>`, worktree, записывает права и модель воркера и печатает бриф, по которому корневая сессия открывает подсессию (`start_session`). Фабрика видит только Ready из `origin/main`. Штаб с `sh-worker` остаётся запасным способом (`docs/process.md` §7.1). Подробно: `docs/process.md` §7, шаг 3.
- Спецификации полные на один этап вперёд: задача текущего (самый ранний этап с задачами не в Done) или следующего этапа с самого начала содержит описание, критерии приёмки и план тестов; более поздние остаются краткими (`docs/process.md` §3.3).
- Закрытие цикла: `factory merge` после добра владельца коммитит статус Merged, сливает squash, удаляет ветку и worktree, подтягивает `main` и архивирует подсессию. Статус Done ставит шаг `deploy` (скрипт `scripts/mark-done.mjs`) после успешной выкладки (`docs/process.md` §7.1).
- Основная папка: `pnpm sync` и `pnpm status` приводят её в порядок и показывают состояние задач и PR, `pnpm git:prune` чистит локальные ветки; флаги и примеры в [README.md](README.md#основная-папка-pnpm-sync-и-pnpm-status).
- Шаблон задачи и Definition of Ready штаб читает командами `node scripts/doc.mjs process 4` и `node scripts/doc.mjs process 5`, а не файлом целиком; порядок работы над спецификацией лежит в скилле `sh-spec`. Перед PR спецификаций штаб запускает `pnpm spec:check SH-NNN` ([README.md](README.md#проверки)); CI на PR запускает его для изменённых задач в Ready. После зелёного `pnpm spec:check` штаб вызывает субагента `sh-spec-critic` («Проверь спецификацию SH-NNN») на каждую задачу PR, при необходимости параллельно. Пункты «блокирует» он исправляет и вызывает критика повторно. Вердикт критика по каждой задаче и непринятые замечания с причиной он пишет в описании PR спецификаций. Критик не заменяет согласование владельцем и в CI не запускается (`docs/process.md` §7.1). Из плагинов аккаунта проекту нужен только `mattpocock-skills`: в CLI остальные отключает `.claude/settings.json`, в приложении их выключает владелец в аккаунте; `docs/process.md` §7.1.
- Бриф рабочей сессии: ID задачи, ссылка на §7.1, особенности задачи; процесс не пересказывать.

## Коммиты и PR

Conventional Commits (`feat(schedule): …`, `test(auth): …`) с ID задачи. PR: `SH-NNN: <название>`, слияние squash при зелёном CI. Коммитить и пушить — только когда владелец просит или это шаг согласованного процесса задачи.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.55.3 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
