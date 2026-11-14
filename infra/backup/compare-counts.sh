#!/usr/bin/env bash
# Сверка числа строк: compare-counts.sh <prod.txt> <restored.txt> (SH-012). Формат строк: схема.таблица|число.
# Копия снимается через несколько минут после prod, поэтому небольшая разница допустима:
# разница не больше max(RESTORE_CHECK_MAX_ABS_DIFF, число_на_prod * RESTORE_CHECK_MAX_PCT_DIFF / 100). Умолчания: 3 и 2.
# Код выхода 1, если таблицы не совпадают, разница больше допуска или сверять нечего.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Использование: $0 <prod.txt> <restored.txt>" >&2
  exit 2
fi

awk -F'|' -v max_abs="${RESTORE_CHECK_MAX_ABS_DIFF:-3}" -v max_pct="${RESTORE_CHECK_MAX_PCT_DIFF:-2}" '
  NR == FNR { if ($1 != "") { prod[$1] = $2 + 0; order[++n] = $1 } next }
  { if ($1 != "") restored[$1] = $2 + 0 }
  END {
    bad = 0
    if (n == 0) { print "FAIL: на prod нет таблиц для сверки"; exit 1 }
    for (i = 1; i <= n; i++) {
      t = order[i]
      if (!(t in restored)) { print "FAIL " t ": таблицы нет в копии"; bad = 1; continue }
      diff = prod[t] - restored[t]; if (diff < 0) diff = -diff
      limit = prod[t] * max_pct / 100; if (limit < max_abs) limit = max_abs
      if (diff > limit) { printf "FAIL %s: prod=%d копия=%d допуск=%d\n", t, prod[t], restored[t], limit; bad = 1 }
      else printf "OK %s: prod=%d копия=%d\n", t, prod[t], restored[t]
    }
    for (t in restored) if (!(t in prod)) { print "FAIL " t ": таблицы нет на prod"; bad = 1 }
    exit bad
  }
' "$1" "$2"
