#!/usr/bin/env bash
# Первичная настройка prod-сервера (SH-010). Ubuntu LTS, запуск один раз под root:
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... comment" bash server-setup.sh
# Скрипт можно запускать повторно: он ничего не ломает.
# DEPLOY_PUBKEY — публичный ключ (не секрет). Приватный ключ на сервер не копируется.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти скрипт под root." >&2
  exit 1
fi
if [ -z "${DEPLOY_PUBKEY:-}" ]; then
  echo "Задай DEPLOY_PUBKEY: публичный SSH-ключ пользователя deploy." >&2
  exit 1
fi
case "$DEPLOY_PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) echo "DEPLOY_PUBKEY не похож на публичный SSH-ключ." >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive

echo "==> Обновление пакетов"
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl gnupg ufw unattended-upgrades

echo "==> Пользователь deploy"
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
# Пароля у deploy нет, поэтому sudo без пароля: вход под root закрыт.
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-deploy
chmod 440 /etc/sudoers.d/90-deploy
visudo -cf /etc/sudoers.d/90-deploy >/dev/null

echo "==> SSH: только ключи, без root"
# Имя 00- ставит файл первым: sshd берёт первое значение параметра,
# а cloud-init кладёт в 50-cloud-init.conf строку PasswordAuthentication yes.
cat > /etc/ssh/sshd_config.d/00-studhub.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
SSHD
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "Действующие значения sshd:"
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication) '

echo "==> Firewall: 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo "==> Автоматические обновления безопасности"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT
systemctl enable --now unattended-upgrades

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker deploy

echo "==> Каталог приложения /srv/studhub"
install -d -m 750 -o deploy -g deploy /srv/studhub

echo "Готово. Проверь вход в новой вкладке: ssh deploy@<адрес сервера>"
