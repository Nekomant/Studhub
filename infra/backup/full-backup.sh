#!/usr/bin/env bash
# Ежедневный полный бэкап Postgres через wal-g и удаление старых (SH-012, ТД §12 «Бэкапы»).
# Запуск на сервере: bash backup/full-backup.sh (cron: studhub-backup.cron).
# Хранение: последние BACKUP_RETAIN_FULL полных бэкапов (по умолчанию 30, то есть 30 суток при бэкапе раз в сутки)
# и все WAL, нужные для них. Если backup-push упал, ничего не удаляем.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

require_env WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY
retain="${BACKUP_RETAIN_FULL:-30}"

fail() {
  log "ОШИБКА: $1" >&2
  notify "Бэкап не выполнен: $1. Подробности в /var/log/studhub-backup.log." || true
  exit 1
}

log "полный бэкап: старт"
compose exec -T -u postgres postgres sh -c '/opt/walg/wal-g backup-push "$PGDATA"' || fail "wal-g backup-push завершился с ошибкой"
log "полный бэкап: готов, удаляю старые (оставляю ${retain})"
compose exec -T -u postgres postgres /opt/walg/wal-g delete retain FULL "$retain" --confirm || fail "не удалось удалить старые бэкапы"
log "готово"
