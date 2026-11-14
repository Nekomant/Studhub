# Prod-сервер Studhub

Как поднять prod-сервер с нуля. Почему так: [ADR-0007](../docs/adr/0007-vps-hosting.md), устройство: ТД §12.

В конце получится сервер, на котором работают Caddy (принимает запросы и сам выпускает HTTPS-сертификаты), Postgres и приложение. Приложение выкладывает GitHub Actions при каждом слиянии в `main` (шаги 8–11).

## Что в папке

| Файл | Что делает |
|---|---|
| `server-setup.sh` | Готовит чистый сервер: создаёт пользователя `deploy`, закрывает вход по паролю, включает firewall и автообновления, ставит Docker |
| `docker-compose.prod.yml` | Описывает три контейнера: `caddy`, `app` и `postgres`. Порт Postgres наружу не открыт |
| `deploy.sh` | Выкладывает образ приложения с указанным тегом: миграции, обновление, проверка `/healthz`. Тот же скрипт откатывает на предыдущий тег |
| `Caddyfile` | Настройки Caddy для `studshub.ru` и `app.studshub.ru` |
| `.env.prod.example` | Шаблон файла с секретами `.env` |
| `.env.backup.example` | Шаблон файла `.env.backup` с ключами бэкапа и Telegram (шаг 12) |
| `smoke-prod.sh` | Проверяет сервер снаружи: HTTPS, открытые порты, вход по SSH |
| `backup/` | Бэкапы Postgres через wal-g, проверка восстановления и алерты в Telegram (шаг 12) |

Шаги 1–4 владелец делает сам: это покупки и доступы. Остальные шаги выполняются по SSH.

## 1. Арендовать VPS

1. Открой панель хостинг-провайдера и создай виртуальный сервер в российском регионе.
2. Выбери параметры: 2 vCPU, 4 ГБ памяти, 40 ГБ SSD, образ Ubuntu 24.04 LTS.
3. Включи публичный IPv4-адрес и запиши его.
4. Для первого входа выбери вход по паролю или по SSH-ключу. Этот способ нужен один раз, дальше им никто не пользуется.

## 2. Купить домен

Купи домен `studshub.ru` у регистратора. Убедись, что у регистратора включён DNS-хостинг: в нём ты заведёшь записи на шаге 4.

## 3. Создать SSH-ключ

Ключ состоит из двух файлов: приватного и публичного. Создай его на своём компьютере. Приватный ключ никому не передавай и никуда не копируй.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/studhub_deploy -C "studhub-deploy"
cat ~/.ssh/studhub_deploy.pub
```

Вторая команда показывает публичный ключ. Он не секрет, его вставишь на шаге 5.

## 4. Указать адрес сервера в DNS

Заведи у регистратора A-записи. Каждая связывает имя с IPv4-адресом сервера:

| Имя | Тип | Значение |
|---|---|---|
| `@` (то есть `studshub.ru`) | A | адрес сервера |
| `app` (то есть `app.studshub.ru`) | A | адрес сервера |
| `www` | A | адрес сервера |

Записи доходят до всех не сразу, иногда до часа. Проверь:

```bash
dig +short studshub.ru
dig +short app.studshub.ru
```

Обе команды должны напечатать адрес сервера. Пока этого нет, не переходи дальше: без DNS Caddy не получит сертификат.

## 5. Подготовить сервер

Скрипт `server-setup.sh` выполняется на сервере один раз под `root`.

```bash
scp infra/server-setup.sh root@<адрес>:/root/
ssh root@<адрес> 'DEPLOY_PUBKEY="<содержимое studhub_deploy.pub>" bash /root/server-setup.sh'
```

Если провайдер вместо `root` дал пользователя с `sudo` (например, `ubuntu`), загрузи скрипт ему и запусти так:

```bash
scp infra/server-setup.sh ubuntu@<адрес>:~/
ssh ubuntu@<адрес> 'sudo DEPLOY_PUBKEY="<содержимое studhub_deploy.pub>" bash ~/server-setup.sh'
```

Что скрипт делает:

- обновляет пакеты;
- создаёт пользователя `deploy` и кладёт ему твой публичный ключ. Пароля у `deploy` нет, `sudo` он выполняет без пароля;
- запрещает вход по паролю и вход под `root`, дальше на сервер заходят только по ключу (настройка лежит в `/etc/ssh/sshd_config.d/00-studhub.conf`);
- включает firewall `ufw`: снаружи открыты порты 22 (SSH), 80 и 443 (сайт), всё остальное закрыто;
- включает автоматическую установку обновлений безопасности (`unattended-upgrades`);
- ставит Docker и добавляет `deploy` в группу `docker`;
- создаёт каталог `/srv/studhub`.

Скрипт можно запускать повторно, он ничего не ломает.

❗ Не закрывай текущее подключение, пока не проверишь вход под `deploy`. Иначе при ошибке можно потерять доступ к серверу. Открой второе окно терминала:

```bash
ssh -i ~/.ssh/studhub_deploy deploy@<адрес> 'docker --version && sudo -n true && echo ok'
```

Команда должна напечатать версию Docker и `ok`.

## 6. Скопировать файлы на сервер

```bash
scp -i ~/.ssh/studhub_deploy infra/docker-compose.prod.yml infra/Caddyfile infra/.env.prod.example deploy@<адрес>:/srv/studhub/
```

## 7. Заполнить `.env`

В `.env` лежат пароли. Файл создаётся только на сервере и в репозиторий не попадает. Зайди на сервер командой `ssh -i ~/.ssh/studhub_deploy deploy@<адрес>` и выполни:

```bash
cd /srv/studhub
cp .env.prod.example .env
chmod 600 .env
nano .env
```

Заполни строки:

- `ACME_EMAIL`: твой email. На него Let's Encrypt шлёт уведомления о сертификатах;
- `POSTGRES_PASSWORD`: случайный пароль. Получить его можно командой `openssl rand -hex 24`;
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: приложение не запускается, пока все пять заданы. Хранилища файлов ещё нет, поэтому до задачи про материалы впиши заглушки: `https://s3.invalid`, `stub`, `stub-bucket`, `stub`, `stub`. Настоящие значения появятся вместе с хранилищем.

Ключи бэкапов и алертов (`WALG_*`, `AWS_*`, `TELEGRAM_*`) в `.env` не клади. Они лежат в отдельном файле `.env.backup` (шаг 12): `.env` читает контейнер `app`, а этим ключам там не место.

Сохрани файл в `nano`: Ctrl+O, Enter, Ctrl+X. Пароль не отправляй в чат и почту, храни в менеджере паролей.

## 8. Запустить базовые сервисы

На сервере, в каталоге `/srv/studhub`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d caddy postgres
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs caddy | tail -n 30
```

В логах Caddy видно, как он получает сертификаты. Контейнер `app` запускает `deploy.sh` после первой выкладки (шаг 11).

Если Docker не может скачать образы с Docker Hub (для российских адресов бывают ограничения), укажи зеркало в `/etc/docker/daemon.json` (параметр `registry-mirrors`) и перезапусти Docker.

## 9. Проверить снаружи

Проверка идёт с твоего компьютера, не с сервера:

```bash
SSH_KEY=~/.ssh/studhub_deploy infra/smoke-prod.sh
```

Для скрипта нужен `python3`.

Скрипт проверяет:

- `https://app.studshub.ru/healthz` и `https://studshub.ru/` отвечают 200 с действующим сертификатом;
- адреса с `http://` перенаправляют на `https://`;
- порты 22, 80 и 443 открыты, а 3000, 3306, 5432, 6379, 8080 и 9000 закрыты;
- SSH не пускает по паролю и не пускает под `root`;
- автообновления включены (для этого нужен `SSH_KEY`).

Если включён VPN или прокси, проверка закрытых портов может соврать: VPN сам принимает любое соединение. Скрипт замечает это по контрольному порту 54321. Выключи VPN или на macOS укажи сетевой интерфейс:

```bash
IFACE=en0 SSH_KEY=~/.ssh/studhub_deploy infra/smoke-prod.sh
```

Дополнительно просканируй все порты своего сервера:

```bash
nmap -Pn -p- <адрес>
```

В списке должны быть только 22, 80 и 443.

## 10. Подготовить выкладку

Это делает владелец: нужны токены и ключи. Значения не отправляй в чат и не клади в репозиторий.

1. Создай в GitHub токен для чтения образов: Settings > Developer settings > Personal access tokens (classic), право `read:packages`.
2. На сервере выполни один раз `docker login ghcr.io -u <твой логин GitHub>` и вставь токен по запросу. Docker сохранит вход в `~/.docker/config.json` пользователя `deploy`.
3. В репозитории открой Settings > Secrets and variables > Actions и создай четыре секрета:

| Секрет | Значение |
|---|---|
| `DEPLOY_SSH_KEY` | Содержимое приватного ключа `~/.ssh/studhub_deploy` целиком |
| `DEPLOY_HOST` | `app.studshub.ru` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | Вывод `ssh-keyscan -t ed25519 app.studshub.ru` |

Перед тем как класть вывод `ssh-keyscan` в секрет, сверь отпечаток с тем, что показывает веб-консоль провайдера: `ssh-keygen -lf <(ssh-keyscan -t ed25519 app.studshub.ru 2>/dev/null)`.

## 11. Выкладка и откат

После слияния в `main` workflow `CI` сам собирает образ, публикует его в GHCR с тегом SHA коммита и вызывает на сервере `deploy.sh`. Job `deploy` красный, если `/healthz` не ответил за 60 секунд.

Выложить или откатить вручную (на сервере, в `/srv/studhub`):

```bash
./deploy.sh <тег>
```

Тег — это SHA коммита из Actions или из `git log`. Предыдущий тег хранится в `APP_TAG` в `.env` до следующей выкладки, а при неудачной проверке скрипт печатает команду отката. Миграции откат не отменяет: схема меняется только вперёд (ТД §12), поэтому образ предыдущего тега должен работать на новой схеме.

## 12. Бэкапы, проверка восстановления и алерты

Устройство: ТД §12 «Бэкапы» и «Наблюдение», решение: [ADR-0007](../docs/adr/0007-vps-hosting.md). Без проверенного восстановления бэкап не считается.

Что работает после настройки:

- Postgres непрерывно отправляет WAL в бакет (`archive_command` вызывает `wal-g wal-push`, сегмент уходит не реже чем раз в 5 минут).
- Каждую ночь в 03:30 по времени сервера `backup/full-backup.sh` делает полный бэкап и оставляет 30 последних полных бэкапов вместе с нужным им WAL. `wal-g backup-push` ограничен по времени: `BACKUP_TIMEOUT_HOURS` часов (по умолчанию 2).
- Каждое воскресенье в 05:00 `backup/restore-check.sh` поднимает копию из бэкапа во временном контейнере и сверяет число строк с prod.
- Каждые 10 минут `backup/alerts.sh` проверяет условия и пишет в Telegram.
- Ключи бэкапа лежат в отдельном файле `/srv/studhub/.env.backup` (права 600). Его читают контейнер `postgres` и скрипты `backup/`. Контейнер `app` его не получает.
- Данные в бакете шифруются libsodium ключом `WALG_LIBSODIUM_KEY`. Бакет принадлежит другому провайдеру, чем VPS (у нас VK Cloud, ключи отделены от `S3_*` приложения).

### Значения в `.env.backup`

Шаблон лежит в `.env.backup.example`. Файл создаётся только на сервере: `cd /srv/studhub && cp .env.backup.example .env.backup && chmod 600 .env.backup`. Значения владелец вносит сам, в чат их не пишет. Все переменные из таблицы лежат в `.env.backup`, в `.env` их быть не должно: `install.sh` на это проверяет. Переменные `POSTGRES_*`, `S3_*` и остальные остаются в `.env`.

| Переменная | Что это |
|---|---|
| `WALG_S3_PREFIX` | `s3://<бакет>/<папка>`, например `s3://bucket-studhub/prod` |
| `AWS_ENDPOINT` | Адрес S3 провайдера, например `https://hb.ru-msk.vkcloud-storage.ru` |
| `AWS_REGION` | Регион, например `ru-msk` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Ключ доступа к бакету |
| `WALG_LIBSODIUM_KEY` | Ключ шифрования: 64 шестнадцатеричных символа, получить: `openssl rand -hex 32` |
| `TELEGRAM_API_URL`, `TELEGRAM_PROXY_SECRET` | Адрес Worker и общий секрет, если Telegram закрыт с сервера (наш случай). Токен бота тогда в `.env.backup` не нужен: он хранится только в Cloudflare (см. «Прокси для Telegram») |
| `TELEGRAM_CHAT_ID` | Число chat id. С прокси необязателен: Worker может хранить его сам |
| `TELEGRAM_BOT_TOKEN` | Токен бота. Нужен только без прокси, при пустом `TELEGRAM_API_URL`. Тогда `TELEGRAM_CHAT_ID` тоже обязателен |

❗ Сохрани копию `WALG_LIBSODIUM_KEY` в менеджере паролей вне сервера. Без ключа бэкапы не прочитать, и сменить ключ на уже записанных данных нельзя: после смены ключа старые бэкапы остаются на старом ключе.

wal-g принимает путь к бакету в стиле `AWS_S3_FORCE_PATH_STYLE=true`: compose задаёт его сам. Тип хранилища «Icebox» у VK Cloud рассчитан на редкое чтение. Если запись WAL или бэкапа в него не проходит, смени тип бакета на «Hotbox» и повтори.

### Как менять `.env.backup` на работающем сервере

Файл `.env.backup` входит в конфигурацию контейнера `postgres` (`env_file` в compose). Правка файла меняет эту конфигурацию. Поэтому следующий `docker compose up -d` пересоздаёт `postgres`: контейнер останавливается и стартует заново. Простой длится несколько секунд. За это время приложение теряет соединение с базой, запросы получают ошибку, а `/healthz` отвечает не 200. Данные в томе `postgres-data` остаются.

Скрипты `backup/*.sh` читают `.env.backup` при каждом запуске. Для них перезапуск не нужен.

1. Выбери время без уроков, лучше ночью по зоне преподавателя. Проверь, что полный бэкап и проверка восстановления не идут: `pgrep -f backup/`.
2. Правь файл на сервере: `nano /srv/studhub/.env.backup`. Права остаются 600.
3. Если изменились только `TELEGRAM_*`, перезапуск `postgres` не обязателен: ему эти значения не нужны. Но `up -d` при следующей выкладке всё равно пересоздаст контейнер. Можно пересоздать сразу, в тихое время.
4. Если изменились `WALG_*` или `AWS_*`, пересоздай `postgres` сразу: `docker compose -f docker-compose.prod.yml --env-file .env up -d postgres`. Пока контейнер работает со старыми значениями, архивация WAL идёт по старому ключу и бакету.
5. Проверь: `curl -sS -o /dev/null -w '%{http_code}' https://<домен>/healthz` печатает 200. Затем выполни `pg_switch_wal` и проверку `pg_stat_archiver` из шагов 5–6 раздела «Установка на сервер»: `failed_count` не растёт.
6. Смена `WALG_LIBSODIUM_KEY` на работающих данных не поддерживается (см. предупреждение выше).

Команда `up -d app` тоже пересоздаёт `postgres`, если `.env.backup` изменился с прошлого запуска. Это ожидаемо: так было при проверке UptimeRobot.

### Установка на сервер

Выполняет владелец один раз по SSH под `deploy`. Порядок важен: compose не запускает ни один сервис без файла `.env.backup`, а Postgres не стартует без файла `bin/wal-g`.

1. Создай `.env.backup` из шаблона и заполни значения из таблицы выше. Права файла: `chmod 600 .env.backup`. Если эти ключи уже лежат в `.env`, перенеси их в `.env.backup` и удали из `.env`.
2. Скопируй папку `backup`, шаблон и compose на сервер: `scp -r -i ~/.ssh/studhub_deploy infra/backup infra/docker-compose.prod.yml infra/.env.backup.example deploy@<адрес>:/srv/studhub/`. После слияния в `main` job `deploy` копирует их сам.
3. На сервере выполни `cd /srv/studhub && bash backup/install.sh`. Скрипт скачивает wal-g, сверяет контрольную сумму, ставит расписание в `/etc/cron.d/studhub-backup` и ничего не печатает из `.env` и `.env.backup`. Скрипт отказывается работать, если права файлов шире 600, значение пусто или ключи бэкапа остались в `.env`.
4. Проверь Telegram: `bash backup/alerts.sh --test`. Сообщение должно прийти в чат. Если команда напечатала «Telegram недоступен» и `curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.telegram.org` зависает, сервер не достаёт до `api.telegram.org`. Тогда настрой прокси по разделу «Прокси для Telegram» и повтори шаг.
5. Включи архивацию WAL: `docker compose -f docker-compose.prod.yml --env-file .env up -d postgres`. Контейнер Postgres перезапускается за несколько секунд.
6. Проверь архивацию:

```bash
docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres psql -U studhub -d studhub -c "select pg_switch_wal()"
sleep 20
docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres psql -U studhub -d studhub -x -c "select archived_count, failed_count, last_archived_wal, last_failed_wal from pg_stat_archiver"
```

В выводе `archived_count` больше 0, а `failed_count` равен 0 (или не растёт).

7. Сделай первый бэкап и посмотри список:

```bash
bash backup/full-backup.sh
docker compose -f docker-compose.prod.yml --env-file .env exec -T -u postgres postgres /opt/walg/wal-g backup-list --detail
```

В списке появилась строка `base_…`. Дата в ней свежая.

8. Проверь, что данные в бакете зашифрованы. Возьми имя файла из `wal-g st ls` и прочитай его первые байты:

```bash
W="docker compose -f docker-compose.prod.yml --env-file .env exec -T -u postgres postgres /opt/walg/wal-g"
$W st ls basebackups_005/
```

Шифрование подтверждает любое из двух: `$W backup-fetch` с другим `WALG_LIBSODIUM_KEY` (через `exec -e WALG_LIBSODIUM_KEY=<другой ключ>`) падает с ошибкой расшифровки, а правильный ключ в проверке восстановления (шаг 9) проходит.

9. Запусти проверку восстановления: `bash backup/restore-check.sh`. Скрипт печатает `OK <таблица>: prod=… копия=…` по каждой таблице и в конце «проверка восстановления прошла». Статус лежит в `/var/lib/studhub-backup/restore-check.status`.

### Если архивация WAL не идёт

Симптом: после `pg_switch_wal()` в `pg_stat_archiver` остаются `archived_count=0` и `failed_count=0`, а в `/var/lib/postgresql/18/docker/pg_wal/archive_status` копятся файлы `.ready`. Процесс `wal-g wal-push` висит минутами. Проверка:

```bash
docker compose -f docker-compose.prod.yml --env-file .env exec -T -u postgres postgres timeout 60 /opt/walg/wal-g st ls
```

Что проверить по очереди:

1. Корневые сертификаты. В образе `postgres` их нет, поэтому compose монтирует `/etc/ssl/certs/ca-certificates.crt` с хоста и задаёт `SSL_CERT_FILE`. Без сертификатов `wal-g` не проходит TLS (в `openssl s_client` внутри контейнера: «unable to get local issuer certificate») и повторяет запрос минутами. Файл есть на Ubuntu после `sudo apt-get install -y ca-certificates`. `install.sh` проверяет его наличие.
2. Значения `WALG_*` и `AWS_*` в `.env.backup` (права 600, без кавычек и пробелов вокруг `=`).
3. Доступ контейнера к бакету: `curl -sS -m 10 -o /dev/null -w '%{http_code}\n' <AWS_ENDPOINT>` на хосте.

Зависший `wal-g` больше не блокирует архивацию бесконечно: `archive_command` обёрнут в `timeout 180`, Postgres сам повторяет неудачную отправку. Ошибки видны в `docker compose … logs postgres` и в `failed_count`.

### Что считается ключевыми таблицами и допуском

Скрипт сравнивает все таблицы схем `public` (данные приложения) и `drizzle` (журнал миграций). Очередь pg-boss не сравнивается: она меняется каждую минуту. Копия снимается через несколько минут после prod, поэтому допустима разница не больше `max(3, 2% от числа строк на prod)`. Допуск задают `RESTORE_CHECK_MAX_ABS_DIFF` и `RESTORE_CHECK_MAX_PCT_DIFF`. Таблица, которой нет в копии или на prod, и пустой список таблиц дают ошибку.

### Прокси для Telegram

С нашего VPS `api.telegram.org` не открывается. Алерты идут через Cloudflare Worker: сервер шлёт `POST <адрес Worker>/send`, а Worker пересылает сообщение в Telegram. Код лежит в `infra/telegram-proxy/worker.js`.

Токен бота хранится только в Cloudflare, в секрете Worker `TELEGRAM_BOT_TOKEN`. На сервере токена нет: в `.env.backup` лежат только адрес Worker и общий секрет `TELEGRAM_PROXY_SECRET`. Если секрет с сервера утечёт, им можно только слать сообщения в наш чат, а токен останется у Cloudflare.

Worker не работает как открытый прокси:

- он принимает только `POST /send` с телом из `chat_id` и `text` (форма или JSON) и пересылает его на `https://api.telegram.org/bot<токен>/sendMessage`; другие поля тела он отбрасывает, остальные пути и методы получают 404;
- каждый запрос должен нести заголовок `X-Proxy-Secret` с общим секретом (сравнение за постоянное время), иначе ответ 403;
- тело больше 8 КБ получает 413, запрос без `text` получает 400;
- если в Worker не задан `PROXY_SECRET` или `TELEGRAM_BOT_TOKEN`, ответ 500;
- он не пишет в лог токен бота и тексты сообщений.

Чат можно зафиксировать в Worker: задай переменную `TELEGRAM_CHAT_ID`. Тогда запрос может не передавать `chat_id`, а запрос с другим `chat_id` получает 403. Это защита на случай, если общий секрет утечёт: через Worker нельзя писать в чужие чаты. Тексты алертов не содержат ПДн.

Создание Worker (владелец, один раз, в личном кабинете Cloudflare, бесплатного тарифа достаточно):

1. Открой `dash.cloudflare.com`, раздел Workers & Pages, кнопка Create, затем Create Worker. Назови его `studhub-telegram-proxy` и нажми Deploy.
2. Нажми Edit code. Удали пример кода, вставь целиком содержимое файла `infra/telegram-proxy/worker.js` и нажми Deploy.
3. Сгенерируй общий секрет на своём компьютере: `openssl rand -hex 32`. Сохрани его в менеджере паролей.
4. В Worker открой Settings, Variables and Secrets, Add. Добавь три значения и нажми Deploy:
   - тип Secret, имя `PROXY_SECRET`, значение из шага 3;
   - тип Secret, имя `TELEGRAM_BOT_TOKEN`, значение: токен бота от BotFather;
   - тип Text, имя `TELEGRAM_CHAT_ID`, значение: число chat id (необязательно, но рекомендуется).
5. Скопируй адрес Worker вида `https://studhub-telegram-proxy.<аккаунт>.workers.dev` (в Settings, Domains & Routes).
6. Внеси в `/srv/studhub/.env.backup`: `TELEGRAM_API_URL=<адрес из шага 5 без слэша в конце>` и `TELEGRAM_PROXY_SECRET=<секрет из шага 3>`. Права файла остаются 600. Если там остались `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` от прежней схемы, удали токен: в режиме прокси скрипты его не читают.
7. Проверь: `bash backup/alerts.sh --test`. Сообщение приходит в чат.

Если адрес `workers.dev` с сервера не открывается, привяжи к Worker свой домен (Settings, Domains & Routes, Add, Custom domain) и подставь его в `TELEGRAM_API_URL`. Проверка доступности с сервера: `curl -sS -m 10 -o /dev/null -w '%{http_code}\n' <адрес>/send`: ответ 403 значит, что Worker отвечает.

Если сообщения перестали приходить, проверь по очереди: адрес Worker, совпадение `PROXY_SECRET` в Cloudflare и `TELEGRAM_PROXY_SECRET` в `.env.backup`, секрет `TELEGRAM_BOT_TOKEN` в Cloudflare, chat id. Ответ 500 значит, что в Worker не хватает секрета, 403 значит, что секреты не совпали или chat id чужой.

### Алерты

Сообщения приходят в Telegram от бота. В них нет ПДн: только фиксированные фразы и числа. Один и тот же алерт повторяется не чаще раза в 6 часов, при восстановлении условия счётчик сбрасывается.

| Условие | Порог | Настройка |
|---|---|---|
| Последнему бэкапу больше | 26 часов | `BACKUP_MAX_AGE_HOURS` |
| Проверка восстановления упала, не запускалась больше 8 суток или ни разу не завершилась | 8 суток | |
| Диск заполнен больше чем на | 80% | `DISK_MAX_PERCENT` |
| Доступной памяти меньше | 10% | `MEM_MIN_PERCENT` |

Проверка условий вручную (каждая команда должна прислать сообщение):

```bash
cd /srv/studhub
ALERT_REPEAT_HOURS=0 BACKUP_MAX_AGE_HOURS=0 bash backup/alerts.sh
ALERT_REPEAT_HOURS=0 DISK_MAX_PERCENT=1 bash backup/alerts.sh
ALERT_REPEAT_HOURS=0 MEM_MIN_PERCENT=99 bash backup/alerts.sh
echo "fail $(date +%s)" > /var/lib/studhub-backup/restore-check.status
ALERT_REPEAT_HOURS=0 bash backup/alerts.sh
bash backup/restore-check.sh   # вернёт статус ok
```

Если бэкап упал, `full-backup.sh` шлёт алерт сразу, не дожидаясь 26 часов. То же происходит, если `wal-g backup-push` не уложился в `BACKUP_TIMEOUT_HOURS` (по умолчанию 2 часа): `timeout` внутри контейнера останавливает wal-g, скрипт завершается с кодом 1, старые бэкапы не удаляются. Чтобы изменить значение, поставь его перед командой в `/etc/cron.d/studhub-backup`, например `BACKUP_TIMEOUT_HOURS=4 bash …`; повторный запуск `install.sh` вернёт расписание из репозитория. Значение должно быть целым числом часов, не меньше 1.

### UptimeRobot

Это делает владелец в личном кабинете uptimerobot.com.

1. Создай монитор типа HTTP(s): URL `https://app.studshub.ru/healthz`, интервал 5 минут (минимум бесплатного тарифа; владелец согласовал 5 минут вместо 1).
2. Добавь канал уведомлений (почта или Telegram) и привяжи его к монитору.
3. Проверка: останови приложение (`docker compose -f docker-compose.prod.yml --env-file .env stop app`) и дождись уведомления. Запусти его снова: `docker compose -f docker-compose.prod.yml --env-file .env up -d app`.

### Восстановление на момент времени (проверка)

Эта команда не трогает prod: она поднимает копию во временном контейнере, доигрывает WAL до выбранного момента и печатает число строк.

1. Запиши момент времени T в UTC: `date -u +%Y-%m-%dT%H:%M:%SZ`. К этому моменту уже должен существовать полный бэкап.
2. Создай метку: `docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres psql -U studhub -d studhub -c "create table public.pitr_marker as select 1 as id"`.
3. Подожди минуту и запиши момент T2. Добавь вторую строку: `… psql -U studhub -d studhub -c "insert into public.pitr_marker values (2)"`. Затем переключи WAL: `… psql -U studhub -d studhub -c "select pg_switch_wal()"` и подожди 30 секунд.
4. Запусти: `bash backup/restore-check.sh --target-time <T2>`. Выбирается последний бэкап не позже T2, WAL доигрывается до T2. В выводе должна быть строка `public.pitr_marker|1`: вторая строка добавлена после T2 и в копии её нет.
5. Удали метку: `… psql -U studhub -d studhub -c "drop table public.pitr_marker"`.

Формат времени: только UTC, `YYYY-MM-DDTHH:MM:SSZ`. Скрипт сам превращает его в `YYYY-MM-DD HH:MM:SS+00`: Postgres не принимает `T` и `Z`. Другой формат скрипт отклоняет с кодом 2.

Если контейнер копии остановился, скрипт сразу печатает последние 20 строк его лога и завершается с кодом 1. Статус еженедельной проверки при этом не меняется: запуск с `--target-time` его не пишет и алерт не шлёт.

Команда без `--target-time` проверяет последний бэкап и весь WAL. Она же запускается по cron раз в неделю.

### Восстановление после потери данных

Используй, когда данных на сервере нет или они испорчены. Время простоя: десятки минут.

1. Подготовь сервер по шагам 1–8 этого файла (для существующего сервера пропусти). Положи в `.env.backup` прежние `WALG_*`, `AWS_*` и `TELEGRAM_*`, включая тот же `WALG_LIBSODIUM_KEY`.
2. ❗ Остановка и удаление тома стирают текущие данные Postgres. Убедись, что восстанавливаешь из бэкапа, а не тратишь рабочие данные. Выполни в `/srv/studhub`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env stop app postgres
docker compose -f docker-compose.prod.yml --env-file .env rm -f postgres
docker volume rm studhub_postgres-data
docker volume create studhub_postgres-data
```

3. Скачай бэкап в том. Для восстановления на момент времени задай `RESTORE_TARGET_TIME` (UTC); без него берётся последний бэкап и весь WAL:

```bash
set -a; . ./.env.backup; set +a
docker run --rm --user root --entrypoint bash \
  -v studhub_postgres-data:/var/lib/postgresql -v "$PWD/bin":/opt/walg:ro -v "$PWD/backup/restore-fetch.sh":/restore-fetch.sh:ro \
  -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  -e WALG_S3_PREFIX -e AWS_ENDPOINT -e AWS_REGION -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e WALG_LIBSODIUM_KEY \
  -e WALG_LIBSODIUM_KEY_TRANSFORM=hex -e AWS_S3_FORCE_PATH_STYLE=true -e WALG_COMPRESSION_METHOD=zstd \
  -e RESTORE_TARGET_TIME="${RESTORE_TARGET_TIME:-}" \
  postgres:18 /restore-fetch.sh
```

4. Запусти Postgres и дождись конца восстановления: `docker compose -f docker-compose.prod.yml --env-file .env up -d postgres`, затем `docker compose -f docker-compose.prod.yml --env-file .env logs -f postgres`. В логе появится «database system is ready to accept connections» после «archive recovery complete».
5. Запусти приложение: `./deploy.sh $(grep ^APP_TAG= .env | cut -d= -f2)`. Новый полный бэкап сделай сразу: `bash backup/full-backup.sh`.

## Обслуживание

- Вход на сервер: `ssh -i ~/.ssh/studhub_deploy deploy@<адрес>`. Вход по паролю и под `root` закрыт.
- Состояние firewall: `sudo ufw status verbose`.
- Журнал автообновлений: `sudo tail /var/log/unattended-upgrades/unattended-upgrades.log`.
- Сертификаты хранятся в томе `caddy-data`, Caddy продлевает их сам.
- Если потерял ключ, зайди через веб-консоль в панели провайдера и добавь новый публичный ключ в `/home/deploy/.ssh/authorized_keys`.

## Ограничения

- Docker обходит правила `ufw` для портов, которые контейнер публикует наружу. Поэтому наружу смотрит только `caddy` (порты 80 и 443). У `postgres` и `app` секции `ports` нет, и добавлять её нельзя.
- HTTP/3 (UDP 443) выключен: firewall пропускает только TCP.
- Старые образы остаются на диске, чтобы откат был быстрым. Раз в месяц выполняй `docker image prune -a --filter until=720h`.
