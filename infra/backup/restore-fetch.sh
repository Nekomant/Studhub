#!/usr/bin/env bash
# Выполняется ВНУТРИ одноразового контейнера postgres:18 под root (SH-012). Его запускают restore-check.sh и инструкция аварийного
# восстановления в infra/README.md. Скачивает бэкап wal-g в PGDATA и готовит восстановление; сам Postgres не запускает.
# Переменные: WALG_* и AWS_* (данные бакета и ключ), RESTORE_BACKUP_NAME (по умолчанию LATEST),
# RESTORE_TARGET_TIME (UTC, YYYY-MM-DDTHH:MM:SSZ): взять последний бэкап не позже этого момента и остановить восстановление на нём.
set -euo pipefail

WALG=/opt/walg/wal-g
PGDATA="${PGDATA:-/var/lib/postgresql/18/docker}"
name="${RESTORE_BACKUP_NAME:-LATEST}"
target="${RESTORE_TARGET_TIME:-}"

if [ -n "$target" ] && [[ ! "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "RESTORE_TARGET_TIME должен быть в UTC: YYYY-MM-DDTHH:MM:SSZ" >&2
  exit 2
fi

if [ -n "$target" ] && [ "$name" = "LATEST" ]; then
  # backup-list печатает бэкапы по возрастанию времени: name, modified, wal_segment_backup_start.
  name="$(gosu postgres "$WALG" backup-list | awk -v t="${target%Z}" 'NR > 1 && substr($2, 1, 19) <= t { n = $1 } END { print n }')"
  if [ -z "$name" ]; then
    echo "Нет бэкапа, сделанного не позже $target" >&2
    exit 1
  fi
fi

echo "Бэкап: $name"
install -d -m 700 -o postgres -g postgres "$PGDATA"
gosu postgres "$WALG" backup-fetch "$PGDATA" "$name"

gosu postgres touch "$PGDATA/recovery.signal"
{
  echo "restore_command = '$WALG wal-fetch %f %p'"
  echo "recovery_target_action = 'promote'"
  [ -z "$target" ] || echo "recovery_target_time = '$target'"
} | gosu postgres tee -a "$PGDATA/postgresql.auto.conf" >/dev/null
echo "Готово: данные в $PGDATA, при первом запуске Postgres доиграет WAL"
