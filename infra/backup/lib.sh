#!/usr/bin/env bash
# Общие функции скриптов бэкапа (SH-012). Файл подключают командой `. "$(dirname "$0")/lib.sh"`, сам он ничего не запускает.
# Скрипты работают на сервере. Каталог с docker-compose.prod.yml, .env и .env.backup берётся из DEPLOY_DIR (по умолчанию родитель папки backup),
# состояние (статус проверки восстановления, метки алертов) лежит в STATE_DIR (по умолчанию /var/lib/studhub-backup).

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${STATE_DIR:-/var/lib/studhub-backup}"
cd "$DEPLOY_DIR" || exit 1

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# .env: пароль Postgres и настройки приложения. .env.backup: ключи бакета, ключ шифрования и Telegram (читает контейнер postgres, но не app).
for file in .env .env.backup; do
  if [ ! -f "$file" ]; then
    log "Нет файла $file в $(pwd)." >&2
    exit 1
  fi
done

# Значения читаем построчно, файлы не выполняем (в них могут быть спецсимволы).
env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'" || true; }
backup_value() { grep -E "^$1=" .env.backup | tail -n 1 | cut -d= -f2- | tr -d "\"'" || true; }

compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

# Завершает скрипт, если в .env.backup не задано одно из значений. Сами значения не печатаем.
require_env() {
  local name missing=""
  for name in "$@"; do
    [ -n "$(backup_value "$name")" ] || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    log "В .env.backup не заданы:$missing" >&2
    exit 1
  fi
}

# Экспортирует значения wal-g из .env.backup, чтобы передать контейнерам по имени (`docker run -e ИМЯ`): значения не попадают в аргументы.
export_walg_env() {
  local name
  for name in WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY; do
    export "$name=$(backup_value "$name")"
  done
}

# Отправляет текст в Telegram. Токен и адрес передаём curl через stdin, чтобы токен не попал в список процессов.
# Текст пишем без ПДн: только фиксированные фразы и числа. Код возврата 1, если Telegram не принял сообщение.
notify() {
  local token chat base text proxy_secret header
  token="$(backup_value TELEGRAM_BOT_TOKEN)"
  chat="$(backup_value TELEGRAM_CHAT_ID)"
  base="$(backup_value TELEGRAM_API_URL)"
  base="${base:-https://api.telegram.org}"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "Telegram не настроен: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.backup." >&2
    return 1
  fi
  text="[studhub prod] $1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  # Если Telegram закрыт с сервера, TELEGRAM_API_URL указывает на прокси (infra/telegram-proxy), а общий секрет уходит заголовком.
  proxy_secret="$(backup_value TELEGRAM_PROXY_SECRET)"
  proxy_secret="${proxy_secret//\\/\\\\}"
  proxy_secret="${proxy_secret//\"/\\\"}"
  header=""
  [ -z "$proxy_secret" ] || header="$(printf 'header = "X-Proxy-Secret: %s"\n' "$proxy_secret")"
  if ! { printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' \
    "$base" "$token" "$chat" "$text"; [ -z "$header" ] || printf '%s\n' "$header"; } | curl -sS -f --max-time 15 -K - -o /dev/null; then
    log "Telegram не принял сообщение." >&2
    return 1
  fi
}

mkdir -p "$STATE_DIR"
