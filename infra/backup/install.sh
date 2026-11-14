#!/usr/bin/env bash
# Установка бэкапов на prod-сервер (SH-012). Запуск один раз под пользователем deploy из /srv/studhub:
#   bash backup/install.sh
# Скрипт можно запускать повторно. Что делает:
#   - скачивает wal-g зафиксированной версии, сверяет контрольную сумму и кладёт в /srv/studhub/bin/wal-g;
#   - проверяет, что в .env.backup заданы все значения для бэкапов, а права .env и .env.backup равны 600 (значения не печатает);
#   - создаёт каталог состояния, файл журнала и ротацию журнала;
#   - ставит расписание в /etc/cron.d/studhub-backup.
# Postgres начнёт архивировать WAL после следующей выкладки (deploy.sh пересоздаёт контейнер с новой конфигурацией).
set -euo pipefail

WALG_VERSION=v3.0.9
WALG_SHA256=444ce216230c254edef803e098a59a1746806da3e0d55671d7b0f0082db14ef4
WALG_URL="https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-24.04-amd64.tar.gz"

here="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="${DEPLOY_DIR:-$(dirname "$here")}"
cd "$deploy_dir"

command -v python3 >/dev/null || { echo "Нужен python3 (разбор списка бэкапов в alerts.sh): sudo apt-get install -y python3" >&2; exit 1; }
# Compose монтирует этот файл в контейнер postgres: в образе нет корневых сертификатов. Без файла Docker создаст вместо него каталог.
ca_bundle="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
[ -f "$ca_bundle" ] || { echo "Нет $ca_bundle: sudo apt-get install -y ca-certificates" >&2; exit 1; }
for file in .env .env.backup; do
  [ -f "$file" ] || { echo "Нет файла $deploy_dir/$file." >&2; exit 1; }
  mode="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")"
  [ "$mode" = "600" ] || { echo "Права $file: ${mode}, нужны 600. Выполни: chmod 600 $file" >&2; exit 1; }
done

env_backup_value() { grep -E "^$1=" .env.backup | tail -n 1 | cut -d= -f2- || true; }
# Telegram: с TELEGRAM_API_URL алерты идут через прокси (токен бота хранится только в Cloudflare), иначе нужен токен бота.
required="WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY"
if [ -n "$(env_backup_value TELEGRAM_API_URL)" ]; then
  required="$required TELEGRAM_PROXY_SECRET"
else
  required="$required TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID"
fi
missing=""
for name in $required; do
  [ -n "$(env_backup_value "$name")" ] || missing="$missing $name"
done
[ -z "$missing" ] || { echo "В .env.backup не заданы:$missing" >&2; exit 1; }
# Ключи бэкапа не должны лежать в .env: этот файл читает контейнер app.
leaked="$(grep -E '^(WALG_|AWS_|TELEGRAM_)[A-Z0-9_]*=' .env | cut -d= -f1 | tr '\n' ' ' || true)"
[ -z "$leaked" ] || { echo "В .env остались ключи бэкапа: $leaked. Перенеси их в .env.backup и удали из .env." >&2; exit 1; }
key="$(grep -E '^WALG_LIBSODIUM_KEY=' .env.backup | tail -n 1 | cut -d= -f2-)"
[[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "WALG_LIBSODIUM_KEY должен состоять из 64 шестнадцатеричных символов (openssl rand -hex 32)." >&2; exit 1; }

echo "==> wal-g ${WALG_VERSION}"
install -d -m 755 bin
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/walg.tar.gz" "$WALG_URL"
echo "${WALG_SHA256}  $tmp/walg.tar.gz" | sha256sum -c - >/dev/null || { echo "Контрольная сумма wal-g не совпала." >&2; exit 1; }
tar -xzf "$tmp/walg.tar.gz" -C "$tmp"
install -m 755 "$tmp/wal-g-pg-24.04-amd64" bin/wal-g
bin/wal-g --version

echo "==> Состояние, журнал, расписание"
sudo install -d -m 750 -o deploy -g deploy /var/lib/studhub-backup
sudo install -m 640 -o deploy -g deploy /dev/null /var/log/studhub-backup.log 2>/dev/null || true
sudo tee /etc/logrotate.d/studhub-backup >/dev/null <<'LOGROTATE'
/var/log/studhub-backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
}
LOGROTATE
sudo install -m 644 -o root -g root "$here/studhub-backup.cron" /etc/cron.d/studhub-backup

echo "Готово. Дальше: deploy.sh (включает архивацию WAL), затем bash backup/alerts.sh --test и bash backup/full-backup.sh."
