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

# Корневые сертификаты хоста для временных контейнеров postgres: в образе их нет, без них wal-g не проходит TLS.
CA_BUNDLE="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
ca_args=(-v "$CA_BUNDLE":/etc/ssl/certs/ca-certificates.crt:ro -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt)

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

# Отправляет текст в Telegram. Секреты и адрес передаём curl через stdin, чтобы они не попали в список процессов.
# Текст пишем без ПДн: только фиксированные фразы и числа. Код возврата 1, если Telegram не принял сообщение.
# Два режима. С TELEGRAM_API_URL запрос идёт на прокси `$TELEGRAM_API_URL/send` (infra/telegram-proxy): токен бота хранится только
# в Cloudflare, здесь он не нужен и не читается, а общий секрет TELEGRAM_PROXY_SECRET уходит заголовком X-Proxy-Secret.
# Без TELEGRAM_API_URL запрос идёт прямо на api.telegram.org с TELEGRAM_BOT_TOKEN.
notify() {
  local token chat base text proxy_secret url
  chat="$(backup_value TELEGRAM_CHAT_ID)"
  base="$(backup_value TELEGRAM_API_URL)"
  text="[studhub prod] $1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  if [ -n "$base" ]; then
    proxy_secret="$(backup_value TELEGRAM_PROXY_SECRET)"
    if [ -z "$proxy_secret" ]; then
      log "Telegram не настроен: при TELEGRAM_API_URL задай TELEGRAM_PROXY_SECRET в .env.backup." >&2
      return 1
    fi
    proxy_secret="${proxy_secret//\\/\\\\}"
    proxy_secret="${proxy_secret//\"/\\\"}"
    # chat_id необязателен: Worker может хранить его сам.
    if ! { printf 'url = "%s/send"\nheader = "X-Proxy-Secret: %s"\n' "${base%/}" "$proxy_secret"
      [ -z "$chat" ] || printf 'data-urlencode = "chat_id=%s"\n' "$chat"
      printf 'data-urlencode = "text=%s"\n' "$text"; } | curl -sS -f --max-time 15 -K - -o /dev/null; then
      log "Telegram не принял сообщение." >&2
      return 1
    fi
    return 0
  fi
  token="$(backup_value TELEGRAM_BOT_TOKEN)"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "Telegram не настроен: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.backup или TELEGRAM_API_URL с TELEGRAM_PROXY_SECRET." >&2
    return 1
  fi
  url="https://api.telegram.org/bot${token}/sendMessage"
  if ! printf 'url = "%s"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' "$url" "$chat" "$text" \
    | curl -sS -f --max-time 15 -K - -o /dev/null; then
    log "Telegram не принял сообщение." >&2
    return 1
  fi
}

mkdir -p "$STATE_DIR"
