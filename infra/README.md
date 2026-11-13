# Prod-сервер Studhub

Пошаговая настройка prod-сервера с нуля. Решение: [ADR-0007](../docs/adr/0007-vps-hosting.md), устройство: ТД §12.

Что лежит в папке:

| Файл | Зачем |
|---|---|
| `server-setup.sh` | Первичная настройка сервера: пользователь `deploy`, SSH, firewall, автообновления, Docker |
| `docker-compose.prod.yml` | `caddy`, `app`, `postgres` (порт наружу не открыт) |
| `Caddyfile` | `studshub.ru` и `app.studshub.ru`, автоматический TLS |
| `.env.prod.example` | Шаблон `.env` для сервера |
| `smoke-prod.sh` | Проверка снаружи: HTTPS, порты, SSH |

Шаги 1–4 делает владелец (покупки и доступы). Шаги 5–10 выполняются по SSH.

## 1. Арендовать VPS

1. Открой панель провайдера и создай облачный сервер (VPS) в российском регионе.
2. Параметры: 2 vCPU, 4 ГБ RAM, 40 ГБ SSD, образ Ubuntu 24.04 LTS.
3. Включи публичный IPv4-адрес. Запиши адрес.
4. На шаге «доступ» выбери вход по паролю или SSH-ключу для `root`. Это нужно только для первого входа.

## 2. Купить домен

1. Купи домен `studshub.ru` у регистратора.
2. Включи DNS-хостинг регистратора или провайдера VPS.

## 3. Создать SSH-ключ

Ключ создаётся на твоём компьютере. Приватный ключ никому не передавай.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/studhub_deploy -C "studhub-deploy"
cat ~/.ssh/studhub_deploy.pub
```

Публичный ключ (файл `.pub`) не секрет. Его вставляют в шаге 5.

## 4. Настроить DNS

Создай две A-записи на IPv4-адрес сервера:

| Имя | Тип | Значение |
|---|---|---|
| `studshub.ru` (`@`) | A | адрес сервера |
| `app.studshub.ru` | A | адрес сервера |

Проверь распространение записей (подожди до часа):

```bash
dig +short studshub.ru
dig +short app.studshub.ru
```

Обе команды печатают адрес сервера. Без этого Caddy не получит сертификат.

## 5. Настроить сервер

Первый вход идёт под `root`, один раз.

```bash
scp infra/server-setup.sh root@<адрес>:/root/
ssh root@<адрес> 'DEPLOY_PUBKEY="<содержимое studhub_deploy.pub>" bash /root/server-setup.sh'
```

Скрипт делает это:

- обновляет пакеты;
- создаёт пользователя `deploy` с твоим публичным ключом и `sudo` без пароля;
- запрещает вход по паролю и под `root` (`/etc/ssh/sshd_config.d/00-studhub.conf`);
- включает `ufw`: открыты 22, 80 и 443 по TCP, остальное закрыто;
- включает `unattended-upgrades` (обновления безопасности);
- ставит Docker и Compose-плагин, добавляет `deploy` в группу `docker`;
- создаёт каталог `/srv/studhub`.

Скрипт идемпотентный: повторный запуск безопасен.

**Предупреждение.** Не закрывай текущую сессию `root`, пока не проверишь вход `deploy`. Открой второе окно:

```bash
ssh -i ~/.ssh/studhub_deploy deploy@<адрес> 'docker --version && sudo -n true && echo ok'
```

## 6. Положить файлы на сервер

```bash
scp -i ~/.ssh/studhub_deploy infra/docker-compose.prod.yml infra/Caddyfile infra/.env.prod.example deploy@<адрес>:/srv/studhub/
```

## 7. Заполнить `.env`

Выполняется на сервере (`ssh -i ~/.ssh/studhub_deploy deploy@<адрес>`).

```bash
cd /srv/studhub
cp .env.prod.example .env
chmod 600 .env
nano .env
```

Заполни:

- `ACME_EMAIL` — твой email для уведомлений Let's Encrypt;
- `POSTGRES_PASSWORD` — случайный пароль: `openssl rand -hex 24`.

`.env` в репозиторий не попадает. Пароль передавай между людьми только через менеджер паролей.

## 8. Запустить

```bash
cd /srv/studhub
docker compose -f docker-compose.prod.yml --env-file .env up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs caddy | tail -n 30
```

В логах Caddy видно, как он получает сертификаты для двух доменов. Сервис `app` пока не запускается: образ появится в задаче «Docker-образ и деплой» (SH-011). До неё `/healthz` на `app.studshub.ru` отвечает сам Caddy, а на `studshub.ru` стоит заглушка.

Если `docker compose pull` не качает образы с Docker Hub (ограничения для российских адресов), настрой зеркало в `/etc/docker/daemon.json` (`registry-mirrors`) и перезапусти Docker.

## 9. Проверить снаружи

Выполняется на твоём компьютере, не на сервере.

```bash
SSH_KEY=~/.ssh/studhub_deploy infra/smoke-prod.sh
```

Если ты за VPN или прокси, проверка закрытых портов даёт ложный результат: соединение принимает сам VPN. Скрипт ловит это контрольным портом 54321. Отключи VPN или на macOS задай интерфейс: `IFACE=en0 SSH_KEY=... infra/smoke-prod.sh`.

Скрипт проверяет:

- `https://app.studshub.ru/healthz` и `https://studshub.ru/` отвечают 200 с валидным сертификатом;
- `http://` перенаправляет на `https://`;
- порты 22, 80 и 443 открыты, а 3000, 3306, 5432, 6379, 8080 и 9000 закрыты;
- SSH не принимает пароль и вход под `root`;
- `unattended-upgrades` включён (нужен `SSH_KEY`).

Дополнительно просканируй все порты (только свой сервер):

```bash
nmap -Pn -p- <адрес>
```

В списке должны быть только 22, 80 и 443. Изнутри сервера слушающие порты показывает `sudo ss -tlnH`: наружу смотрят 22, 80 и 443, остальное слушает `127.0.0.*` (системный DNS).

## 10. Что дальше

- Деплой образа и откат — SH-011.
- Бэкапы и алерты — SH-012.

## Обслуживание

- Вход: `ssh -i ~/.ssh/studhub_deploy deploy@<адрес>`. Пароль и вход под `root` отключены.
- Состояние firewall: `sudo ufw status verbose`.
- Журнал автообновлений: `sudo tail /var/log/unattended-upgrades/unattended-upgrades.log`.
- Сертификаты лежат в томе `caddy-data`, Caddy продлевает их сам.
- Если потерял ключ, зайди через веб-консоль панели VPS, добавь новый публичный ключ в `/home/deploy/.ssh/authorized_keys`.

## Известные ограничения

- Docker обходит правила `ufw` для опубликованных портов. Поэтому порты публикует только `caddy` (80 и 443), у `postgres` и `app` секции `ports` нет. Не добавляй секцию `ports` другим сервисам.
- HTTP/3 (UDP 443) выключен: firewall пропускает только TCP.
- Сервис `app` пока в профиле `app` и не стартует. SH-011 убирает профиль.
