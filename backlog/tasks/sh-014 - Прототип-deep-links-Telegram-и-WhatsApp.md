---
id: SH-014
title: 'Прототип: deep links Telegram и WhatsApp'
status: Backlog
assignee: []
created_date: '2026-11-11T08:58:00Z'
updated_date: '2026-11-12T12:37:00Z'
labels:
  - spike
  - messages
milestone: m-9
dependencies:
  - SH-008
priority: medium
type: spike
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Что нужно сделать
1. Сделать страницу-прототип с тестовым текстом и кнопками: `wa.me/{phone}?text=`, `t.me/{username}`, `t.me/share/url?text=`, «Скопировать».
2. Проверить на iOS и Android (браузер и установленная PWA) и на десктопе с установленными мессенджерами; записать таблицу результатов.
3. Выбрать способ для Telegram и записать решение в ТД §8 и §16.

## Зачем
Отправка сообщений ученику (Ш-13) опирается на deep links. Неясно, позволяет ли Telegram предзаполнить текст в чате по username (ТД §16).

## Контекст
- UC-43, Ш-13. ТД §8 «Сообщения», §16.

## Не входит
Шаблоны и экран сообщений — этап 7.

## План тестов
Результаты — таблица в заметках задачи.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Варианты ссылок проверены на iOS, Android (браузер и установленная PWA) и десктопе; таблица результатов в заметках
- [ ] #2 Выбран способ отправки в Telegram для Ш-13; решение записано в ТД §8 «Сообщения» и §16
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Выводы прототипа отражены в ТД
<!-- DOD:END -->
