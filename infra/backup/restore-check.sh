#!/usr/bin/env bash
# Проверка восстановления из бэкапа (SH-012, ТД §12 «Бэкапы»). Запуск на сервере:
#   bash backup/restore-check.sh                          еженедельная проверка (cron): последний бэкап плюс весь WAL, сверка строк с prod
#   bash backup/restore-check.sh --target-time <UTC>      репетиция восстановления на момент времени, например 2026-11-14T10:00:00Z
# Копия поднимается во временном контейнере без опубликованных портов и без архивации WAL: в бакет она ничего не пишет.
# В обычном режиме результат пишется в STATE_DIR/restore-check.status (первая строка: ok|fail, время в секундах), при ошибке уходит алерт.
# С --target-time сверки со счётчиками prod нет (после выбранного момента данных в копии меньше), скрипт печатает числа строк копии.
# Переменные: RESTORE_WAIT_ATTEMPTS и RESTORE_WAIT_INTERVAL (ожидание конца восстановления, по умолчанию 120 × 5 с),
# ARCHIVE_WAIT_SECONDS (пауза после pg_switch_wal, по умолчанию 30), RESTORE_CHECK_MAX_ABS_DIFF и RESTORE_CHECK_MAX_PCT_DIFF (compare-counts.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

target=""
case "${1:-}" in
  "") ;;
  --target-time)
    target="${2:-}"
    [[ "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "Укажи время в UTC: --target-time 2026-11-14T10:00:00Z" >&2; exit 2; }
    ;;
  *) echo "Использование: $0 [--target-time <UTC>]" >&2; exit 2 ;;
esac

require_env WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY
export_walg_env
db_user="$(env_value POSTGRES_USER)"; db_user="${db_user:-studhub}"
db_name="$(env_value POSTGRES_DB)"; db_name="${db_name:-studhub}"
image="postgres:18"
suffix="$$"
volume="studhub-restore-check-$suffix"
container="studhub-restore-check-$suffix"
work="$(mktemp -d)"
wal_env=(-e WALG_S3_PREFIX -e AWS_ENDPOINT -e AWS_REGION -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e WALG_LIBSODIUM_KEY
  -e WALG_LIBSODIUM_KEY_TRANSFORM=hex -e AWS_S3_FORCE_PATH_STYLE=true -e WALG_COMPRESSION_METHOD=zstd)

# Только эти таблицы: public (данные приложения) и drizzle (журнал миграций). Очередь pg-boss меняется каждую минуту.
count_sql="select table_schema||'.'||table_name||'|'||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_type='BASE TABLE' and table_schema in ('public','drizzle') order by 1"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail_check() {
  log "ОШИБКА: $1" >&2
  if [ -z "$target" ]; then
    echo "fail $(date +%s)" > "$STATE_DIR/restore-check.status"
    notify "Проверка восстановления бэкапа не прошла: $1. Подробности в /var/log/studhub-backup.log." || true
  fi
  exit 1
}

if [ -z "$target" ]; then
  log "prod: переключаю WAL и считаю строки"
  compose exec -T postgres psql -U "$db_user" -d "$db_name" -Atc "select pg_switch_wal()" >/dev/null || fail_check "prod не отвечает"
  compose exec -T postgres psql -U "$db_user" -d "$db_name" -Atc "$count_sql" > "$work/prod.txt" || fail_check "не удалось посчитать строки на prod"
  # Сегмент WAL уходит в архив асинхронно: ждём, чтобы копия включила изменения до этого момента.
  sleep "${ARCHIVE_WAIT_SECONDS:-30}"
fi

log "копия: создаю том и скачиваю бэкап"
docker volume create "$volume" >/dev/null
fetch_env=()
[ -z "$target" ] || { export RESTORE_TARGET_TIME="$target"; fetch_env=(-e RESTORE_TARGET_TIME); }
docker run --rm --user root --entrypoint bash \
  -v "$volume":/var/lib/postgresql -v "$DEPLOY_DIR/bin":/opt/walg:ro -v "$here/restore-fetch.sh":/restore-fetch.sh:ro \
  "${wal_env[@]}" ${fetch_env[@]+"${fetch_env[@]}"} \
  "$image" /restore-fetch.sh || fail_check "не удалось восстановить данные из бэкапа"

log "копия: запускаю Postgres"
docker run -d --name "$container" --memory 1g \
  -v "$volume":/var/lib/postgresql -v "$DEPLOY_DIR/bin":/opt/walg:ro \
  "${wal_env[@]}" \
  "$image" -c listen_addresses= -c archive_mode=off >/dev/null || fail_check "копия не запустилась"

ready=""
attempts="${RESTORE_WAIT_ATTEMPTS:-120}"
for ((i = 1; i <= attempts; i++)); do
  state="$(docker exec "$container" psql -U "$db_user" -d "$db_name" -Atc "select pg_is_in_recovery()" 2>/dev/null || true)"
  if [ "$state" = "f" ]; then ready=1; break; fi
  [ "$i" -lt "$attempts" ] && sleep "${RESTORE_WAIT_INTERVAL:-5}"
done
[ -n "$ready" ] || fail_check "копия не закончила восстановление вовремя"

docker exec "$container" psql -U "$db_user" -d "$db_name" -Atc "$count_sql" > "$work/restored.txt" || fail_check "не удалось посчитать строки в копии"

if [ -n "$target" ]; then
  log "копия на момент $target готова, число строк:"
  cat "$work/restored.txt"
  exit 0
fi

if ! bash "$here/compare-counts.sh" "$work/prod.txt" "$work/restored.txt"; then
  fail_check "числа строк в копии и на prod расходятся"
fi
echo "ok $(date +%s)" > "$STATE_DIR/restore-check.status"
log "проверка восстановления прошла"
