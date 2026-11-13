---
id: SH-010
title: 'Prod-сервер: VPS, Caddy, домены'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-13T12:09:00Z'
labels:
  - infra
milestone: m-0
dependencies:
  - SH-002
priority: high
type: task
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Владелец: арендовать VPS (2 vCPU / 4 ГБ / 40 ГБ, Ubuntu LTS), купить домен `studshub.ru`, выдать исполнителю SSH-доступ.
2. Настроить сервер: пользователь `deploy` с SSH-ключом, запрет входа паролем и под root, firewall (22, 80, 443), автоматические обновления безопасности, Docker.
3. Написать `infra/docker-compose.prod.yml` (`caddy`, `app`, `postgres` без внешнего порта) и `infra/Caddyfile` для `studshub.ru` и `app.studshub.ru` с автоматическим TLS.
4. Настроить DNS и проверить HTTPS и перенаправление с HTTP.
5. Проверить снаружи, какие порты открыты.
6. Записать пошаговую настройку сервера в `infra/README.md`.

## Зачем
Prod нужен с первого этапа: после каждого этапа работающая версия выкладывается (ТД §15). ПДн хранятся в РФ (152-ФЗ).

## Контекст
- ТД §2.1, §9 (технические меры), §12 «Prod». ADR-0007.

## Не входит
Деплой из CI — задача «Docker-образ и деплой». Бэкапы — задача «Бэкапы и алерты».

## Контракт
Нет.

## План тестов
| AC | Уровень | Проверка |
|---|---|---|
| 1 | Ручная | curl по https и http |
| 2 | Ручная | сканирование портов снаружи |
| 3 | Ручная | попытка входа паролем и root |
| 4 | Ручная | владелец читает `infra/README.md` |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `https://app.studshub.ru/healthz` отвечает 200 с валидным TLS-сертификатом; запросы по `http` перенаправляются на `https`
- [x] #2 Снаружи открыты только порты 22, 80 и 443; Postgres извне недоступен
- [x] #3 SSH-вход только по ключу, вход паролем и под root отключён; автоматические обновления безопасности включены
- [ ] #4 Настройка сервера с нуля описана в `infra/README.md` пошагово
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Каждый критерий приёмки покрыт тестом, в названии теста есть ID критерия (AC-n), все тесты зелёные
- [ ] #2 CI зелёный: Biome, tsc, Vitest, API-тесты, E2E, миграции и OpenAPI-клиент актуальны (с момента, когда эти проверки появились в CI)
- [x] #3 Документы (use-cases, screens, technical-design, ADR) обновлены в этом же PR, если поведение или решения изменились
- [ ] #4 Новые эндпоинты покрыты тестом изоляции (чужой кабинет → 404); в логах и product_event нет ПДн; деньги только в minor units
- [ ] #5 Пройдено ревью (/code-review и просмотр диффа владельцем), замечания закрыты
- [ ] #6 PR слит в main через squash, изменения выложены в prod (после появления деплоя)
- [x] #7 В заметках задачи записаны оценка и фактическое время, решения по ходу работы и итоговое резюме
- [ ] #8 Владелец оплатил VPS и домен и настроил DNS (покупки делает владелец)
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Написать infra/smoke-prod.sh: проверка снаружи для AC-1…AC-3 (curl по https и http, порты, вход по SSH паролем и под root). Сейчас он красный: сервера нет. Отдельный коммит.
2. Написать infra/Caddyfile (studshub.ru, app.studshub.ru, автоматический TLS, редирект http→https, /healthz) и infra/docker-compose.prod.yml (caddy, app, postgres без внешнего порта, ротация логов 10x50 МБ).
3. Написать infra/server-setup.sh (deploy, SSH только по ключу, ufw 22/80/443, unattended-upgrades, Docker) и infra/.env.prod.example.
4. Написать infra/README.md: настройка сервера с нуля по шагам, DNS, проверка.
5. Шаги владельца (VPS, домен, SSH, DNS): остановка и передача владельцу.
6. Применить на сервере, прогнать infra/smoke-prod.sh, отметить критерии.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Оценка: 6 ч

Решение: пока нет образа app (SH-011), /healthz на app.studshub.ru отвечает сам Caddy (respond 200), сервис app в compose в профиле app и не стартует. SH-011 убирает заглушку и профиль.
Решение: deploy получает sudo без пароля (root-вход закрыт, пароля нет). HTTP/3 выключен: firewall пропускает только TCP 443.
Решение: проверка AC-1…AC-3 снаружи — скрипт infra/smoke-prod.sh (красный до появления сервера).
Ждёт владельца: арендовать VPS (2 vCPU/4 ГБ/40 ГБ, Ubuntu 24.04), купить studshub.ru, создать SSH-ключ, настроить A-записи studshub.ru и app.studshub.ru, передать адрес сервера и публичный ключ

Замечание 1 (исправлено): реальный домен studshub.ru (две «s»), в docs/ и задачах был studhub.ru. Решение владельца: заменить везде. Заменено в infra/, docs/ (ТД, use-cases, screens, ADR-0009), AC-1 и задачах SH-015, SH-075, SH-076, SH-085, SH-088. Файлы других задач правились через backlog task edit скриптом (текст раздела читался из файла и передавался флагом -d, --final-summary или --acceptance-criteria). Имя образа ghcr.io/nekomant/studhub и имена ключей не менялись.
Решение: провайдер VPS в файлах этой задачи не называем, пишем «VPS». Название провайдера VPS остаётся в docs/technical-design.md (стр. 216, 692), docs/adr/0007-vps-hosting.md (стр. 12) и docs/product-concept.md (стр. 159); решение владельца по ним не принято.
Ждёт владельца: SSH-вход на 195.209.210.7 не работает (порт 22 открыт, но баннер SSH не приходит, таймаут). Нужны: состояние сервера в панели VPS, первый вход под root, DNS studshub.ru пока даёт NXDOMAIN.

Факт: шаги 5–6 выполнены (server-setup.sh через ssh vps под ubuntu): deploy по ключу, sshd без пароля и root, ufw 22/80/443, unattended-upgrades active, Docker 29.9.3, файлы в /srv/studhub, .env создан с правами 600 из шаблона. Ошибка скрипта на Ubuntu 24.04 (нет /run/sshd при sshd -t) исправлена.
Дальше: DNS studshub.ru, app, www теперь резолвятся в 195.209.210.7. Ждёт владельца: ввести в /srv/studhub/.env значения ACME_EMAIL и POSTGRES_PASSWORD, потом шаг 8 (запуск compose) и шаг 9 (smoke-prod.sh).

Факт: 5 ч. Prod запущен: caddy и postgres (healthy) в /srv/studhub, сертификаты Let's Encrypt для studshub.ru и app.studshub.ru получены.
Проверка AC-1…AC-3: IFACE=en0 DOMAIN=studshub.ru SSH_KEY=... infra/smoke-prod.sh — все проверки прошли. Полный скан портов 1–65535 снаружи (python, IP_BOUND_IF, в обход VPN): открыты только 22, 80, 443. Внутри: ss -tlnH — наружу слушают 22, 80, 443. Postgres порт не публикует.
Решение: локальный VPN принимает любое TCP-соединение (ложные «открытые» порты). smoke-prod.sh получил контрольный порт 54321 и переменную IFACE.
Замечание 2: pnpm verify в этой ветке нестабилен без связи с задачей (меняется только infra/ и файл задачи): падают разные тесты tools/* по таймауту 5 с и api (openapi, jobs, migrations); состав падений меняется от запуска к запуску. Чем грозит: ложный красный в локальной проверке; причина не установлена.
Замечание 3 (исправлено): в ТД §12 добавлена строка про редирект www.studshub.ru на основной домен и заглушку /healthz до SH-011 (решение владельца).
Ждёт владельца: прочитать infra/README.md (AC-4), оплата/DoD 8 подтверждается владельцем.

Замечание 2, уточнение: vitest с --testTimeout=60000 --fileParallelism=false прошёл целиком: 42 файла, 947 тестов. Обычный pnpm verify падает по таймауту 5 с (git-тесты tools/*), число упавших 9–37 от запуска к запуску. Причина: нагрузка на машину, не код ветки.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Prod-сервер настроен: VPS (Ubuntu 24.04), пользователь deploy по ключу, SSH без пароля и root, ufw 22/80/443, unattended-upgrades, Docker. В infra/ добавлены docker-compose.prod.yml (caddy, app в профиле, postgres без порта), Caddyfile с автоматическим TLS и редиректом http→https и www→основной домен, server-setup.sh, .env.prod.example, README с пошаговой настройкой и smoke-prod.sh для проверки снаружи. Проверено: smoke-prod.sh зелёный, скан портов 1–65535 показал только 22, 80, 443. Домен в infra/ studshub.ru (реальный), документы и задачи приведены к этому домену. До SH-011 /healthz отвечает сам Caddy.
<!-- SECTION:FINAL_SUMMARY:END -->
