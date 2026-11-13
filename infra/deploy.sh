#!/usr/bin/env bash
# Выкладка образа приложения на prod (SH-011, ТД §12 «CD»). Запускается на сервере в /srv/studhub:
#   ./deploy.sh <тег>     например: ./deploy.sh 3f2a9c1d… (SHA коммита) или предыдущий тег для отката.
# Шаги: migrate -> pull -> up -d -> проверка /healthz. Если проверка не прошла, код выхода 1.
# Откат — тот же скрипт с предыдущим тегом: ./deploy.sh <предыдущий тег>. Миграции только вперёд (ТД §12).
# Переменные: DEPLOY_DIR (каталог с docker-compose.prod.yml и .env, по умолчанию каталог скрипта),
# HEALTH_URL (по умолчанию https://app.<DOMAIN>/healthz), HEALTH_ATTEMPTS (по умолчанию 30) и HEALTH_INTERVAL (секунд, по умолчанию 2).
set -euo pipefail

usage() {
  echo "Использование: $0 <тег образа>" >&2
  echo "Тег состоит из букв, цифр, точки, дефиса и подчёркивания." >&2
}

tag="${1:-}"
if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  usage
  exit 2
fi

cd "${DEPLOY_DIR:-$(dirname "$0")}"

if [ ! -f .env ]; then
  echo "Нет файла .env в $(pwd). Создай его по .env.prod.example." >&2
  exit 1
fi
# В .env лежат пароли. Права шире 600 значат, что файл мог прочитать кто-то ещё.
mode=$(stat -c %a .env 2>/dev/null || stat -f %Lp .env)
if [ "$mode" != "600" ]; then
  echo "Права .env: ${mode}, нужны 600. Выполни: chmod 600 .env" >&2
  exit 1
fi

# Значения из .env читаем построчно, файл не выполняем (в нём могут быть спецсимволы).
env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'" || true; }

previous=$(env_value APP_TAG)
domain=$(env_value DOMAIN)
url="${HEALTH_URL:-https://app.${domain:-studshub.ru}/healthz}"

# Переменная окружения сильнее .env: compose берёт нужный тег, а .env обновим после успешного запуска.
export APP_TAG="$tag"
compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

echo "==> migrate (тег ${tag})"
compose run --rm app migrate

echo "==> pull"
# Только app: образы caddy и postgres без нашей команды не меняем.
compose pull app

echo "==> up -d"
compose up -d
# Caddyfile лежит на сервере файлом: reload применяет его без простоя. Ошибка в Caddyfile остановит выкладку.
compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

# Тег записываем в .env на месте: так сохраняются права 600, и ручной `docker compose up` берёт тот же тег.
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
awk -v tag="$tag" '
  /^APP_TAG=/ { print "APP_TAG=" tag; found = 1; next }
  { print }
  END { if (!found) print "APP_TAG=" tag }
' .env > "$tmp"
cat "$tmp" > .env

echo "==> проверка ${url}"
attempts="${HEALTH_ATTEMPTS:-30}"
interval="${HEALTH_INTERVAL:-2}"
for ((i = 1; i <= attempts; i++)); do
  if curl -fsS --max-time 5 -o /dev/null "$url"; then
    echo "Готово: выложен тег ${tag}"
    exit 0
  fi
  [ "$i" -lt "$attempts" ] && sleep "$interval"
done

echo "Проверка /healthz не прошла за ${attempts} попыток. Предыдущий тег: ${previous:-неизвестен}." >&2
[ -n "$previous" ] && echo "Откат: ./deploy.sh ${previous}" >&2
exit 1
