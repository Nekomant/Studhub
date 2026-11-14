#!/usr/bin/env bash
# Ежедневный полный бэкап Postgres через wal-g и удаление старых (SH-012, ТД §12 «Бэкапы»).
# Запуск на сервере: bash backup/full-backup.sh (cron: studhub-backup.cron).
# Хранение: последние BACKUP_RETAIN_FULL полных бэкапов (по умолчанию 30, то есть 30 суток при бэкапе раз в сутки)
# и все WAL, нужные для них. Если backup-push упал или не уложился в BACKUP_TIMEOUT_HOURS (целое число часов, по умолчанию 2),
# ничего не удаляем, а алерт уходит сразу.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

require_env WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY
retain="${BACKUP_RETAIN_FULL:-30}"
timeout_hours="${BACKUP_TIMEOUT_HOURS:-2}"
[[ "$timeout_hours" =~ ^[1-9][0-9]*$ ]] || { echo "BACKUP_TIMEOUT_HOURS должен быть целым числом часов, не меньше 1: $timeout_hours" >&2; exit 2; }
timeout_seconds=$((timeout_hours * 3600))

fail() {
  log "ОШИБКА: $1" >&2
  notify "Бэкап не выполнен: $1. Подробности в /var/log/studhub-backup.log." || true
  exit 1
}

log "полный бэкап: старт"
# timeout запускается внутри контейнера: остановка клиента docker exec не убила бы wal-g. Код 124 означает, что время вышло.
rc=0
compose exec -T -u postgres postgres sh -c 'exec timeout -k 60 "$1" /opt/walg/wal-g backup-push "$PGDATA"' sh "$timeout_seconds" || rc=$?
[ "$rc" -ne 124 ] || fail "wal-g backup-push не уложился в ${timeout_hours} ч и остановлен"
[ "$rc" -eq 0 ] || fail "wal-g backup-push завершился с ошибкой"
log "полный бэкап: готов, удаляю старые (оставляю ${retain})"
compose exec -T -u postgres postgres /opt/walg/wal-g delete retain FULL "$retain" --confirm || fail "не удалось удалить старые бэкапы"
log "готово"
