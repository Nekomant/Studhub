#!/usr/bin/env bash
# Алерты в Telegram (SH-012, ТД §12 «Наблюдение»). Запуск на сервере по cron каждые 10 минут:
#   bash backup/alerts.sh           проверить условия и отправить алерты
#   bash backup/alerts.sh --test    отправить тестовое сообщение: так проверяют, что Telegram доступен с VPS
# Условия: последнему бэкапу больше BACKUP_MAX_AGE_HOURS (26), проверка восстановления упала или не запускалась больше 8 суток,
# диск заполнен больше чем на DISK_MAX_PERCENT (80), доступной памяти меньше MEM_MIN_PERCENT (10),
# архивация WAL сбоит дольше ARCHIVE_FAIL_MINUTES (30) минут по pg_stat_archiver.
# Возраст бэкапа берётся из STATE_DIR/last-backup.status, который пишет full-backup.sh: хранилище каждые 10 минут не опрашиваем.
# Один и тот же алерт повторяется не чаще, чем раз в ALERT_REPEAT_HOURS (6). Тексты без ПДн: фиксированные фразы и числа.
# Код выхода 1, если Telegram не принял сообщение (метка не ставится, следующий запуск повторит отправку).
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--test" ]; then
  if notify "Проверка доставки алертов: Telegram доступен."; then
    echo "Сообщение отправлено, проверь чат."
    exit 0
  fi
  echo "Telegram недоступен с этого сервера, прокси не отвечает, либо секреты неверны: TELEGRAM_PROXY_SECRET и токен бота в Cloudflare при прокси, TELEGRAM_BOT_TOKEN и chat id без прокси. Прокси: infra/README.md, шаг 12." >&2
  exit 1
fi

mkdir -p "$STATE_DIR/alerts"
now="$(date +%s)"
repeat_seconds=$(( ${ALERT_REPEAT_HOURS:-6} * 3600 ))
rc=0

# alert <ключ> <текст>: шлёт алерт, если с прошлой отправки прошло достаточно времени.
alert() {
  local file="$STATE_DIR/alerts/$1" last=0
  [ -f "$file" ] && last="$(cat "$file")"
  if [ $((now - last)) -lt "$repeat_seconds" ]; then return; fi
  if notify "$2"; then echo "$now" > "$file"; else rc=1; fi
}
# ok <ключ>: условие ушло, следующий сбой отправится сразу.
ok() { rm -f "$STATE_DIR/alerts/$1"; }

# 1. Возраст последнего бэкапа. Время успеха пишет full-backup.sh в STATE_DIR/last-backup.status («ok <секунды Unix>»).
# Если файла нет (например, после переустановки), делаем один запрос списка бэкапов и запоминаем найденное время в этот файл.
max_age=$(( ${BACKUP_MAX_AGE_HOURS:-26} * 3600 ))
backup_status="$STATE_DIR/last-backup.status"
age="error"
backup_kind="" backup_stamp=""
[ -f "$backup_status" ] && { read -r backup_kind backup_stamp _ < "$backup_status" || true; }
case "$backup_stamp" in
  '' | *[!0-9]*) backup_stamp="" ;;
esac
if [ "$backup_kind" = "ok" ] && [ -n "$backup_stamp" ]; then
  age=$(( now - backup_stamp ))
  [ "$age" -ge 0 ] || age=0
elif list="$(compose exec -T -u postgres postgres timeout 60 /opt/walg/wal-g backup-list --json 2>/dev/null)"; then
  age="$(printf '%s' "$list" | python3 -c '
import datetime, json, re, sys
try:
    items = json.load(sys.stdin) or []
    best = None
    for item in items:
        raw = item.get("finish_time") or item.get("time")
        moment = datetime.datetime.fromisoformat(re.sub(r"\.\d+", "", raw).replace("Z", "+00:00"))
        best = moment if best is None or moment > best else best
    print("none" if best is None else int((datetime.datetime.now(datetime.timezone.utc) - best).total_seconds()))
except Exception:
    print("error")
' 2>/dev/null || echo error)"
  case "$age" in
    error | none) ;;
    *) echo "ok $((now - age))" > "$backup_status" ;;
  esac
fi
case "$age" in
  error) alert backup_age "Не удалось получить время последнего бэкапа." ;;
  none) alert backup_age "В хранилище нет ни одного бэкапа." ;;
  *)
    if [ "$age" -gt "$max_age" ]; then
      alert backup_age "Последнему бэкапу $((age / 3600)) ч, допустимо $((max_age / 3600)) ч."
    else ok backup_age; fi
    ;;
esac

# 2. Проверка восстановления: статус пишет restore-check.sh.
status_file="$STATE_DIR/restore-check.status"
if [ ! -f "$status_file" ]; then
  alert restore_check "Проверка восстановления бэкапа ещё ни разу не завершилась."
else
  read -r kind stamp _ < "$status_file" || true
  if [ "$kind" = "fail" ]; then
    alert restore_check "Проверка восстановления бэкапа упала."
  elif [ $((now - ${stamp:-0})) -gt $((8 * 86400)) ]; then
    alert restore_check "Проверка восстановления бэкапа не запускалась больше 8 суток."
  else ok restore_check; fi
fi

# 3. Диск.
used="$(df -P "${DISK_PATH:-/}" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ -n "$used" ] && [ "$used" -gt "${DISK_MAX_PERCENT:-80}" ]; then
  alert disk "Диск заполнен на ${used}%, допустимо ${DISK_MAX_PERCENT:-80}%."
else ok disk; fi

# 4. Память.
meminfo="${MEMINFO_FILE:-/proc/meminfo}"
total="$(awk '/^MemTotal:/ { print $2 }' "$meminfo")"
available="$(awk '/^MemAvailable:/ { print $2 }' "$meminfo")"
if [ -n "$total" ] && [ -n "$available" ] && [ "$total" -gt 0 ]; then
  percent=$((available * 100 / total))
  if [ "$percent" -lt "${MEM_MIN_PERCENT:-10}" ]; then
    alert memory "Мало памяти: доступно ${percent}%, нужно не меньше ${MEM_MIN_PERCENT:-10}%."
  else ok memory; fi
fi

# 5. Архивация WAL: pg_stat_archiver внутри контейнера postgres. Сбой = последняя отправка упала позже последней успешной,
# алерт, если успеха нет дольше ARCHIVE_FAIL_MINUTES (или успехов ещё не было). Тихая база без новых сбоев алерта не даёт.
archive_limit=$(( ${ARCHIVE_FAIL_MINUTES:-30} * 60 ))
archive_sql="select (last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time))::int, coalesce(extract(epoch from now() - last_archived_time)::bigint, -1) from pg_stat_archiver"
if archiver="$(compose exec -T postgres timeout 30 psql -At -F '|' -c "$archive_sql" 2>/dev/null)"; then
  failing="${archiver%%|*}"
  since="${archiver#*|}"
  case "$failing$since" in
    '' | *[!0-9-]*) alert wal_archive "Не удалось прочитать состояние архивации WAL." ;;
    *)
      if [ "$failing" = "1" ] && { [ "$since" -lt 0 ] || [ "$since" -gt "$archive_limit" ]; }; then
        if [ "$since" -lt 0 ]; then
          alert wal_archive "Архивация WAL не работает: успешных отправок в хранилище ещё не было."
        else
          alert wal_archive "Архивация WAL не работает: последняя успешная отправка $((since / 60)) мин назад, допустимо $((archive_limit / 60)) мин."
        fi
      else ok wal_archive; fi
      ;;
  esac
else
  alert wal_archive "Не удалось прочитать состояние архивации WAL."
fi

exit "$rc"
