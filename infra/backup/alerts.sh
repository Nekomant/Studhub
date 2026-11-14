#!/usr/bin/env bash
# Алерты в Telegram (SH-012, ТД §12 «Наблюдение»). Запуск на сервере по cron каждые 10 минут:
#   bash backup/alerts.sh           проверить условия и отправить алерты
#   bash backup/alerts.sh --test    отправить тестовое сообщение: так проверяют, что Telegram доступен с VPS
# Условия: последнему бэкапу больше BACKUP_MAX_AGE_HOURS (26), проверка восстановления упала или не запускалась больше 8 суток,
# диск заполнен больше чем на DISK_MAX_PERCENT (80), доступной памяти меньше MEM_MIN_PERCENT (10).
# Один и тот же алерт повторяется не чаще, чем раз в ALERT_REPEAT_HOURS (6). Тексты без ПДн: фиксированные фразы и числа.
# Код выхода 1, если Telegram не принял сообщение (метка не ставится, следующий запуск повторит отправку).
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--test" ]; then
  if notify "Проверка доставки алертов: Telegram доступен."; then
    echo "Сообщение отправлено, проверь чат."
    exit 0
  fi
  echo "Telegram недоступен с этого сервера или токен и chat id неверны." >&2
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

# 1. Возраст последнего бэкапа по списку в хранилище.
max_age=$(( ${BACKUP_MAX_AGE_HOURS:-26} * 3600 ))
age="error"
if list="$(compose exec -T -u postgres postgres /opt/walg/wal-g backup-list --json 2>/dev/null)"; then
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
fi
case "$age" in
  error) alert backup_age "Не удалось получить список бэкапов из хранилища." ;;
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

exit "$rc"
