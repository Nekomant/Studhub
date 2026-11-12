# Studhub

Веб-приложение (PWA) для частных репетиторов: ученики, расписание, оплаты, контекст уроков, материалы.
Документы:

- [`docs/product-concept.md`](docs/product-concept.md): что и зачем делаем;
- [`docs/technical-design.md`](docs/technical-design.md): как устроено, стек и правила кода;
- [`docs/process.md`](docs/process.md): как работаем над задачами.

## Установка

Нужны Node 24 и pnpm 12. Версия Node записана в `.nvmrc`, версия pnpm записана в поле `packageManager` в `package.json`.

```bash
nvm install    # один раз: ставит Node из .nvmrc
nvm use
npm install -g pnpm@12.18.0    # или corepack, если он есть в вашей сборке Node
pnpm install
pnpm --filter @studhub/ui-tokens exec playwright install chromium
```

`pnpm install` ставит зависимости всех пакетов и git-хуки lefthook (скрипт `prepare`). Вторая команда один раз
скачивает Chromium для браузерного теста темы (`packages/ui-tokens`); без неё `pnpm verify` и `pnpm test` падают
в свежем клоне или worktree. В CI этот шаг уже есть.

## Запуск

SPA пока пустая, её запуск добавит задача «Каркас SPA и E2E-харнесс» (SH-008).

### API (сервер)

Нужны запущенный Postgres (раздел ниже) и файл `.env`.

```bash
pnpm --filter @studhub/api start    # читает .env из корня; слушает PORT (по умолчанию 3000)
curl http://localhost:3000/healthz      # {"status":"ok","db":"ok"}; 503 в формате problem+json, если БД недоступна
pnpm gen:openapi                        # пишет apps/api/openapi.json (OpenAPI 3.1 из zod-схем маршрутов)
```

Маршруты кабинета и прочие API живут под `/api/v1`. Ошибки отдаются как `application/problem+json` с полем `code`.
Логи пишутся в JSON (pino) в stdout. Поля с ПДн и секреты (имена, телефоны, email, заметки, токены, cookie, Authorization) маскируются.

### Локальное окружение: Postgres 18 и Garage (S3)

Нужен Docker с Compose v2. Compose поднимает Postgres 18 и Garage, локальный сервер с S3 API
(замена MinIO, [ADR-0008](docs/adr/0008-garage-local-s3.md)). Бакет для файлов и ключ доступа Garage создаёт сам при старте.

```bash
cp .env.example .env    # один раз: переменные окружения; значения по умолчанию подходят для разработки
pnpm db:up              # поднимает контейнеры и ждёт, пока они будут готовы
pnpm db:down            # останавливает контейнеры; данные остаются в томах
```

Данные лежат в именованных томах Docker, поэтому переживают `db:down` и перезапуск. Удалить их можно командой
`docker compose down -v`. Эта команда стирает dev-данные, запускайте её осознанно.

Адреса: Postgres `localhost:5432`, S3 API `http://localhost:3900` (регион `garage`, адресация по пути).
При создании клиента `@aws-sdk/client-s3` укажите `forcePathStyle: true` и `requestChecksumCalculation: "WHEN_REQUIRED"`,
иначе presigned PUT вернёт ошибку контрольной суммы.

Тестовая БД отдельная, её имя задаётся в `TEST_DATABASE_URL` и должно оканчиваться на `_test`:

```bash
pnpm db:reset-test      # пересоздаёт только тестовую БД; dev-БД не трогает
```

Миграции БД (Drizzle, [ADR-0002](docs/adr/0002-postgres-drizzle.md)) лежат в `apps/api/drizzle/`. Команды запускайте после `pnpm db:up`:

```bash
pnpm --filter @studhub/api db:migrate     # применяет миграции к DATABASE_URL; повторный запуск ничего не меняет
pnpm --filter @studhub/api db:check       # падает, если схема изменена без миграции
pnpm --filter @studhub/api db:generate    # генерирует миграцию по схеме модулей
pnpm --filter @studhub/api start migrate  # то же самое через приложение: так миграции запускает CD
```

Соглашения схемы БД описаны в [`apps/api/src/modules/README.md`](apps/api/src/modules/README.md).

Если порты 5432 или 3900 заняты, задайте `POSTGRES_PORT` или `S3_PORT` в `.env` и поправьте адреса в `DATABASE_URL`,
`TEST_DATABASE_URL`, `S3_ENDPOINT`.

Приложение проверяет переменные окружения при старте по схеме `apps/api/src/platform/config`. Если переменной нет
или её значение неверно, процесс печатает список проблем и завершается с кодом 1. Список переменных — в `.env.example`.

## Проверки

| Команда       | Что делает                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check`  | Biome проверяет формат и линт (`biome ci`), TypeScript проверяет типы во всех пакетах (`tsc -b`) |
| `pnpm test`   | Vitest запускает тесты всех проектов из `vitest.config.ts`                                       |
| `pnpm format` | Biome исправляет формат и порядок импортов                                                       |
| `pnpm db:check` | Падает, если схема Drizzle изменена без миграции                                               |
| `pnpm ac:check` | Падает, если у задачи в Review или Done критерий без метки `[SH-NNN AC-n]` в тестах (`docs/process.md` §8.2) |
| `pnpm spec:check` | Проверяет спецификацию задач по шаблону и Definition of Ready (`docs/process.md` §4, §5). `pnpm spec:check SH-NNN` проверяет указанные задачи в любом статусе, без аргументов все задачи в Ready, с `--changed` Ready-задачи, изменённые относительно `origin/main` |
| `pnpm verify` | `pnpm check` и тесты с коротким выводом                                                          |

Перед коммитом и пушем запускайте `pnpm verify`. CI (`.github/workflows/ci.yml`) на каждый PR и push в `main`
запускает `pnpm check`, `pnpm db:check`, `pnpm ac:check` и `pnpm test` на Postgres 18. На PR он ещё запускает `pnpm spec:check --changed`.

Git-хуки (`lefthook.yml`):

- `pre-commit` проверяет Biome-ом файлы из коммита. Если он нашёл ошибки формата, запустите `pnpm format`.
- `commit-msg` проверяет заголовок по [Conventional Commits](https://www.conventionalcommits.org/ru/):
  `<тип>(<область>): <описание>`, типы `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `ci`, `build`
  (`docs/process.md` §9).

### Очистка локальных веток

После слияния PR GitHub удаляет ветку, а локальная копия остаётся. PR сливаются через squash, поэтому
`git branch --merged` такие ветки не находит. Их находит скрипт `scripts/git-prune.mjs`:

```bash
pnpm git:prune            # git fetch --all --prune и список веток, удалённых на GitHub; ничего не удаляет
pnpm git:prune --delete   # удаляет ветки из этого списка и печатает каждую удалённую с её SHA
```

В список не попадают `main`, ветки без upstream (их не пушили на GitHub) и ветки, открытые в любом worktree.
Ветку из worktree скрипт удалит, когда вы уберёте worktree: `git worktree remove <папка>`.
`--delete` удаляет ветку принудительно (`git branch -D`), в том числе с коммитами, которых нет на GitHub.
Если ветку удалили по ошибке, верните её по SHA из вывода скрипта: `git branch <имя> <SHA>`.

### Основная папка: `pnpm sync` и `pnpm status`

Запускайте в основной папке клона. `pnpm sync` приводит её в порядок после слияний PR:

```bash
pnpm sync            # ничего не меняет; показывает отставание от origin/main, файлы задач в backlog/, совпадающие с origin/main, и ветки, удалённые на GitHub
pnpm sync --apply    # подтягивает main перемоткой (--ff-only), сбрасывает только совпавшие файлы задач, удаляет только показанные ветки
```

Если историю нельзя перемотать до `origin/main`, скрипт слияния не делает и сообщает об этом. Другие незакоммиченные правки он не трогает.

```bash
pnpm status    # задачи в Ready, In Progress и Review; открытые PR с состоянием CI (нужен gh); worktree с ветками
```

Без `gh` команда печатает задачи и worktree и сообщает, что PR недоступны.

### Закрытие задачи: `pnpm close-task`

После слияния PR штаб убирает за задачей одной командой (`docs/process.md` §7.1, шаг 7). Штаб запускает команду в основной папке; работает она и из любого worktree (ниже):

```bash
pnpm close-task SH-091            # ничего не меняет; печатает вердикт по трём проверкам
pnpm close-task SH-091 --apply    # при вердикте «да» перематывает main, удаляет ветку задачи и её чистый worktree
```

Перед проверками скрипт делает `git fetch --all --prune`. Вердикт «да», если одновременно:
PR с названием `SH-NNN: …` слит (`gh pr list --state all`), в `origin/main` у задачи статус Done
(читается из `origin/main`, а не из файлов рабочей папки) и все checks PR завершились `SUCCESS` (`SKIPPED` и `NEUTRAL` допустимы).
С `--apply` скрипт печатает SHA удалённой ветки: вернуть её можно командой `git branch <имя> <SHA>`.
Worktree с незакоммиченными файлами он не трогает, а называет в выводе; чужие ветки и файлы не трогает тоже.

Вывод не длиннее 12 строк, последняя строка: `ЗАКРЫТЬ СЕССИЮ: да` или `ЗАКРЫТЬ СЕССИЮ: нет (<причина>)`.
Коды выхода: 0 — «да», 1 — «нет», 2 — вердикт построить нельзя (нет `gh`, PR не найден или найдено несколько).
Основную папку скрипт берёт из первой записи `git worktree list --porcelain`, а не из папки запуска: все операции идут в ней.
Запуск из worktree задачи (на ветке PR или на отсоединённой голове после перехода с неё) делает всё, кроме удаления самого этого worktree и его ветки:
вердикт будет `ЗАКРЫТЬ СЕССИЮ: нет (worktree этой сессии убирает штаб из основной папки)`, код 1, а повторный запуск из основной папки дочистит.
Чужой worktree скрипт не трогает и ведёт себя как при запуске из основной папки. Без `--apply` из любой папки ничего не меняется.
Если в `origin/main` больше одного файла задачи, статус неоднозначен и вердикт «нет».
Сессию задачи скрипт не архивирует: это делает штаб по вердикту.

### Границы слоёв

Правила границ из ТД §13 проверяет Biome (`noRestrictedImports` в `overrides` файла `biome.json`):

1. `apps/web`, `packages/client-core` и `tests/*` не импортируют `apps/api`.
2. `*/domain/*` не импортирует Hono, Drizzle, драйверы БД, `db/` и `http/`.
3. Модули сервера общаются только через `index.ts`: импорт `modules/<модуль>/{domain,db,http}/` из другого модуля
   запрещён. Biome видит только текст пути импорта, поэтому свой модуль он узнаёт по форме `../domain/`,
   `../../db/` и так далее, до четырёх `../`. Из более глубоких папок такой импорт тоже получит ошибку.
   Модуль состоит из `index.ts`, `domain/`, `db/` и `http/` (ТД §2.4). Других файлов и папок в корне модуля
   правило не видит, поэтому их не заводим. Импорты из `platform/` разрешены.
4. Drizzle, драйверы БД и `platform/db/` импортируются только в `*/db/`.

Biome заменяет опции правила в каждом подходящем блоке `overrides`, а не складывает их. Поэтому каждый блок
перечисляет все запреты для своих файлов. Правила проверяет тест `tools/tests/boundaries.test.ts` на фикстурах
`tools/boundary-fixtures/`: файл `*.bad.ts` нарушает одно правило, файл `*.ok.ts` не нарушает ни одного. Если меняете
правила, добавьте фикстуру.

## Структура

```
apps/
  api/             сервер: Hono, домен, БД (ТД §13)
  web/             SPA кабинета на React, только UI
  landing/         лендинг на Astro
packages/
  client-core/     логика клиента без фреймворка и сгенерированный клиент API
  ui-tokens/       CSS-переменные и тема Tailwind
tests/
  api/             API-тесты чёрным ящиком по HTTP
  e2e/             E2E на Playwright
tools/
  boundary-fixtures/   фикстуры нарушений границ слоёв
  tests/               тесты инструментов и структуры репозитория
scripts/           служебные скрипты (проверка сообщения коммита)
docs/              концепция, сценарии, экраны, ТД, ADR, процесс
backlog/           задачи Backlog.md, меняются только через CLI `backlog`
```
