# StudentsHub

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
```

`pnpm install` ставит зависимости всех пакетов и git-хуки lefthook (скрипт `prepare`).

## Запуск

Приложения пока пустые. Команды запуска добавят задачи:

- «Локальное окружение» (SH-003): Postgres и MinIO в Docker;
- «Каркас API» (SH-004): сервер;
- «Каркас SPA и E2E-харнесс» (SH-008): SPA.

## Проверки

| Команда       | Что делает                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check`  | Biome проверяет формат и линт (`biome ci`), TypeScript проверяет типы во всех пакетах (`tsc -b`) |
| `pnpm test`   | Vitest запускает тесты всех проектов из `vitest.config.ts`                                       |
| `pnpm format` | Biome исправляет формат и порядок импортов                                                       |

Перед коммитом и пушем запускайте `pnpm check` и `pnpm test`, их же потом запустит CI.

Git-хуки (`lefthook.yml`):

- `pre-commit` проверяет Biome-ом файлы из коммита. Если он нашёл ошибки формата, запустите `pnpm format`.
- `commit-msg` проверяет заголовок по [Conventional Commits](https://www.conventionalcommits.org/ru/):
  `<тип>(<область>): <описание>`, типы `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `ci`, `build`
  (`docs/process.md` §9).

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
