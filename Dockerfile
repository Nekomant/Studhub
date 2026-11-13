# syntax=docker/dockerfile:1
# Образ приложения Studhub (SH-011, ТД §12): API на Hono и собранная SPA в одном процессе.
# Сборка: `docker build -t studhub .`. Запуск: `docker run --env-file <файл> -p 3000:3000 studhub`.
# Миграции: `docker run --rm --env-file <файл> studhub migrate`.
# Секреты в образ не попадают: приложение читает их из окружения при старте (.env на сервере лежит вне образа).

# --- Сборка: полные зависимости, сборка SPA, выделение prod-зависимостей API ---
FROM node:24-slim AS build
# Версию pnpm выбирает corepack по полю packageManager в package.json.
RUN corepack enable
WORKDIR /repo
COPY . .
# Скрипты зависимостей не нужны: git-хуки в образе не ставим, а сборочные скрипты проект запрещает.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @studhub/web build
# В /out попадает только @studhub/api с зависимостями из dependencies; dev-зависимостей там нет.
RUN pnpm --filter @studhub/api deploy --prod /out \
    && find /out -name '*.test.ts' -not -path '*/node_modules/*' -delete \
    && rm -rf /out/test /out/vitest.config.ts

# --- Итоговый образ ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_ROOT=/app/web
WORKDIR /app
# Файлы принадлежат root и доступны пользователю node только на чтение.
COPY --from=build /out/ ./
COPY --from=build /repo/apps/web/dist ./web
USER node
EXPOSE 3000
# Состояние БД показывает /healthz: при недоступной БД он отвечает ошибкой.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Аргументы docker run и compose run дописываются к ENTRYPOINT: `migrate` запускает миграции вместо сервера.
ENTRYPOINT ["node", "src/main.ts"]
