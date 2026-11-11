# Соглашения для модулей сервера

Модуль — папка `src/modules/<модуль>/` с подпапками `domain/` (правила, чистый TS), `db/` (схема Drizzle и репозитории) и `http/` (маршруты), плюс публичный `index.ts`. Правила границ — ТД §13, проверяет Biome. Соглашения схемы БД — ТД §4.1. Миграции лежат в `apps/api/drizzle/` и читаются на ревью.

## Схема БД

- **Первичные ключи** — `uuid` с `DEFAULT uuidv7()` (встроено в PostgreSQL 18).
- **Арендатор.** В каждой таблице арендатора есть `workspace_id NOT NULL`, в том числе в дочерних.
- **Составные ключи.** Связи внутри арендатора идут через составные внешние ключи `(workspace_id, x_id)`. Для этого у родительской таблицы есть `UNIQUE (workspace_id, id)`.
- **Время** — `timestamptz`. Даты без времени — `date`, их читаем в зоне преподавателя.
- **Деньги** — `bigint` в minor units (копейки, тиыны, центы) и `char(3)` с кодом ISO 4217. Знаки после запятой берём из справочника в коде.
- **Перечисления** — `text` с `CHECK`, а не enum Postgres: такие значения проще менять миграциями.
- **`created_at` и `updated_at`** есть везде, где строки меняются.

## Пример таблицы арендатора

Фрагмент для ориентира. Модуля `workspaces` и таблицы `groups` в этом примере нет, их добавят соответствующие задачи.

```ts
// Фрагмент: workspaces и groups появятся в своих модулях, здесь они только показаны для ориентира.
import { sql } from "drizzle-orm";
import { bigint, char, check, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../../workspaces/index.ts";

// Ученик внутри кабинета арендатора.
export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    groupId: uuid("group_id"),
    status: text("status").notNull().default("active"),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ключ для составных связей из других таблиц кабинета.
    unique("students_workspace_id_id_key").on(t.workspaceId, t.id),
    // CHECK вместо enum: допустимые значения статуса.
    check("students_status_check", sql`${t.status} IN ('active', 'archived')`),
    // Составной внешний ключ: группа берётся только из того же кабинета.
    foreignKey({
      name: "students_group_fk",
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [groups.workspaceId, groups.id],
    }),
  ],
);
```

Что проверить в таблице:
- `workspace_id` есть и `NOT NULL`;
- внешние ключи на чужие таблицы составные, с `workspace_id` первым столбцом;
- деньги хранятся в `bigint`, а не в `numeric` или `real`;
- время в `timestamptz`;
- статусы проверяет `CHECK`, а не enum.

## Миграции

- Меняете схему в `db/schema.ts` → `pnpm db:generate` → смотрите новый SQL-файл в `apps/api/drizzle/` → коммитите его вместе со схемой.
- `pnpm db:check` падает, если схема изменена без миграции.
- Миграции только вперёд, по схеме «расширить → сжать» (ТД §12). Уже применённый файл не правим.
- Свой SQL (расширения, представления, то, что генератор не умеет) пишем через `pnpm --filter @studhub/api exec drizzle-kit generate --custom --name=<имя>`.
