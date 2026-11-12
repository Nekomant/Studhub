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
3. Порядок: план в задачу → **красные тесты по критериям приёмки** (отдельный коммит) → реализация → правка документов → проверки → `/code-review` → PR → статус Review → владелец пишет «готов слить» → статус Done последним коммитом ветки → слияние.
4. Каждый тест по критерию начинается с метки `[SH-NNN AC-n]`. Менять тест под код без изменения критерия нельзя.
5. Работа вне критериев приёмки — стоп, спросить владельца.
6. Поведение или решение изменилось — правим `docs/` в том же PR; новое архитектурное решение — ADR.

## Жёсткие правила кода (ТД §1, §13)

- Клиент (`apps/web`, `packages/client-core`) и `tests/*` не импортируют `apps/api`: только сгенерированный клиент OpenAPI.
- `domain/` не импортирует `db/`, `http/`, Hono, Drizzle. Модули общаются через публичный `index.ts`. Доступ к БД только в `*/db/`.
- Бизнес-правила только на сервере. Изменения урока — команды, а не `PATCH status`.
- Каждая таблица арендатора содержит `workspace_id`; доступ к данным только через репозитории с `ctx`; каждый эндпоинт кабинета покрыт тестом «чужой кабинет → 404».
- Деньги — `bigint` minor units + ISO 4217. Время — UTC `timestamptz`, даты — в зоне преподавателя.
- Никаких ПДн в логах, `product_event`, алертах и внешних сервисах. Никаких внешних CDN.
- Ошибки API — `application/problem+json` с полем `code`.
- Миграции только вперёд, «расширить → сжать».

## Агент sh-worker и экономия контекста

- Рабочая сессия отдаёт работу по задаче субагенту `sh-worker`: «Новый старт SH-NNN». Агент не спрашивает владельца, а возвращает блок `СТОП SH-NNN` с вопросом. Сессия спрашивает владельца и передаёт ответ дословно: SendMessage агенту «Ответ владельца: …» или новый вызов «Продолжение SH-NNN. Ответ владельца: …». Ревью, пуш, PR и статусы Review и Done делает сессия. Подробно: `docs/process.md` §7.1.
- Задача: `node scripts/task.mjs SH-NNN` вместо `backlog task view`. Документы по разделам: `node scripts/doc.mjs td 4.1`, `uc UC-01`, `screens Э-01`; ТД, `use-cases.md` и `screens.md` целиком не читаем. Проверки: `pnpm verify`.
- Локальные переменные окружения берутся из `.env` основной папки хуком SessionStart, только из списка в `scripts/hooks/session-env.mjs`: `POSTGRES_PORT`, `DATABASE_URL`, `TEST_DATABASE_URL`. `.env` агент не создаёт и не читает.

## Штаб, спецификации и основная папка

- Спецификации штаб пишет в своём worktree, в ветке `specs-…`, и открывает PR «Спецификации: SH-…». Задачи к работе в PR уже в Ready; слияние PR владельцем означает согласование. Сессия задачи стартует от `main` и ничего не переносит из основной папки.
- Владелец пишет сессии задачи, что PR слит. Она проверяет `MERGED` и статус Done в `main`, переводит worktree на `origin/main`, удаляет свою ветку и архивирует себя; не прошло — ничего не удаляет и сообщает. Подробно: `docs/process.md` §7.1.
- Основная папка: `pnpm sync` и `pnpm status` приводят её в порядок и показывают состояние задач и PR, `pnpm git:prune` чистит локальные ветки; флаги и примеры в [README.md](README.md#основная-папка-pnpm-sync-и-pnpm-status).
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
