#!/usr/bin/env bash
# Общие функции скриптов бэкапа (SH-012). Файл подключают командой `. "$(dirname "$0")/lib.sh"`, сам он ничего не запускает.
# Скрипты работают на сервере. Каталог с docker-compose.prod.yml и .env берётся из DEPLOY_DIR (по умолчанию родитель папки backup),
# состояние (статус проверки восстановления, метки алертов) лежит в STATE_DIR (по умолчанию /var/lib/studhub-backup).

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${STATE_DIR:-/var/lib/studhub-backup}"
cd "$DEPLOY_DIR" || exit 1

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ ! -f .env ]; then
  log "Нет файла .env в $(pwd)." >&2
  exit 1
fi

# Значения из .env читаем построчно, файл не выполняем (в нём могут быть спецсимволы).
env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'" || true; }

compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

# Завершает скрипт, если в .env не задано одно из значений. Сами значения не печатаем.
require_env() {
  local name missing=""
  for name in "$@"; do
    [ -n "$(env_value "$name")" ] || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    log "В .env не заданы:$missing" >&2
    exit 1
  fi
}

# Экспортирует значения wal-g из .env, чтобы передать контейнерам по имени (`docker run -e ИМЯ`): значения не попадают в аргументы.
export_walg_env() {
  local name
  for name in WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY; do
    export "$name=$(env_value "$name")"
  done
}

# Отправляет текст в Telegram. Токен и адрес передаём curl через stdin, чтобы токен не попал в список процессов.
# Текст пишем без ПДн: только фиксированные фразы и числа. Код возврата 1, если Telegram не принял сообщение.
notify() {
  local token chat base text
  token="$(env_value TELEGRAM_BOT_TOKEN)"
  chat="$(env_value TELEGRAM_CHAT_ID)"
  base="$(env_value TELEGRAM_API_URL)"
  base="${base:-https://api.telegram.org}"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "Telegram не настроен: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env." >&2
    return 1
  fi
  text="[studhub prod] $1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  if ! printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' \
    "$base" "$token" "$chat" "$text" | curl -sS -f --max-time 15 -K - -o /dev/null; then
    log "Telegram не принял сообщение." >&2
    return 1
  fi
}

mkdir -p "$STATE_DIR"
