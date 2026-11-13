#!/usr/bin/env bash
# Проверка prod-сервера снаружи (SH-010, критерии AC-1…AC-3).
# Запуск с любой машины, не с сервера: `infra/smoke-prod.sh`.
# Переменные: DOMAIN (по умолчанию studshub.ru), SSH_USER (по умолчанию deploy),
# SSH_KEY (путь к ключу для проверки автообновлений; без него эта проверка пропускается).
set -u

DOMAIN="${DOMAIN:-studshub.ru}"
APP_HOST="app.${DOMAIN}"
SSH_USER="${SSH_USER:-deploy}"
SSH_KEY="${SSH_KEY:-}"

failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=$((failed + 1)); }

# Проверки порта: nc -z с таймаутом 3 с.
port_open() { nc -z -w 3 "$1" "$2" >/dev/null 2>&1; }

echo "[SH-010 AC-1] HTTPS и перенаправление с HTTP"
# curl без -k: недействительный сертификат даёт ненулевой код возврата.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${APP_HOST}/healthz" 2>/dev/null || true)
[ "$code" = "200" ] && pass "https://${APP_HOST}/healthz -> 200 с валидным TLS" || fail "https://${APP_HOST}/healthz -> '${code}', нужно 200 с валидным TLS"

for host in "$APP_HOST" "$DOMAIN"; do
  out=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://${host}/healthz" 2>/dev/null || true)
  case "$out" in
    30[1278]\ https://"${host}"/*) pass "http://${host} -> ${out}" ;;
    *) fail "http://${host} -> '${out}', нужно перенаправление на https://${host}" ;;
  esac
done

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/" 2>/dev/null || true)
[ "$code" = "200" ] && pass "https://${DOMAIN}/ -> 200 с валидным TLS" || fail "https://${DOMAIN}/ -> '${code}', нужно 200 с валидным TLS"

echo "[SH-010 AC-2] Открытые порты"
for p in 22 80 443; do
  port_open "$APP_HOST" "$p" && pass "порт ${p} открыт" || fail "порт ${p} закрыт, нужен открытым"
done
# Закрытые порты: Postgres, HTTP-порт приложения, S3 и несколько типичных.
for p in 3000 3306 5432 6379 8080 9000; do
  port_open "$APP_HOST" "$p" && fail "порт ${p} открыт снаружи, нужен закрытым" || pass "порт ${p} закрыт"
done

echo "[SH-010 AC-3] SSH только по ключу, без root"
ssh_opts=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=no)
# Пароль не подставляем: отказ приходит сразу как «Permission denied (publickey)»,
# без приглашения ввести пароль. Приглашение значит, что вход паролем включён.
pw_out=$(ssh "${ssh_opts[@]}" -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=0 "${SSH_USER}@${APP_HOST}" true 2>&1 </dev/null || true)
case "$pw_out" in
  *"Permission denied (publickey)"*) pass "вход паролем отключён (${SSH_USER})" ;;
  *) fail "вход паролем не отклонён: ${pw_out}" ;;
esac

root_out=$(ssh "${ssh_opts[@]}" -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=0 "root@${APP_HOST}" true 2>&1 </dev/null || true)
case "$root_out" in
  *"Permission denied (publickey)"*) pass "вход паролем под root отключён" ;;
  *) fail "вход паролем под root не отклонён: ${root_out}" ;;
esac

if [ -n "$SSH_KEY" ]; then
  key_opts=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10 -o BatchMode=yes)
  # Вход под root даже с ключом должен быть закрыт.
  if ssh "${key_opts[@]}" "root@${APP_HOST}" true >/dev/null 2>&1; then
    fail "вход под root по ключу работает, нужен запрет"
  else
    pass "вход под root по ключу отклонён"
  fi
  if ssh "${key_opts[@]}" "${SSH_USER}@${APP_HOST}" true >/dev/null 2>&1; then
    pass "вход ${SSH_USER} по ключу работает"
    if ssh "${key_opts[@]}" "${SSH_USER}@${APP_HOST}" 'systemctl is-enabled unattended-upgrades && systemctl is-active unattended-upgrades' >/dev/null 2>&1; then
      pass "автоматические обновления безопасности включены"
    else
      fail "unattended-upgrades не включён или не запущен"
    fi
  else
    fail "вход ${SSH_USER} по ключу не работает"
  fi
else
  echo "skip проверка по ключу и автообновлений: SSH_KEY не задан"
fi

if [ "$failed" -gt 0 ]; then
  echo "Не прошло проверок: ${failed}"
  exit 1
fi
echo "Все проверки прошли"
