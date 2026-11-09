# Обновления Tabora

## Как устроено

- **Скачивание и установка** делает штатный обновлятор движка: полный MAR-пакет, проверка подписи,
  установка при перезапуске (staging в фоне). Своего загрузчика нет.
- **Подпись.** MAR подписываются ключом Tabora (`tools/release.py` → `signmar`). Публичные сертификаты
  `release_primary.der` и `release_secondary.der` в `src/toolkit/mozapps/update/updater/` подменяют
  сертификаты Mozilla при сборке (`MOZ_VERIFY_MAR_SIGNATURE=1`), поэтому пакет с чужой подписью
  обновлятор отвергнет. Канал пакетов `MAR_CHANNEL_ID=tabora-release` (configs/common/mozconfig).
- **Ключи** лежат в `.build/mar-keys` (NSS-база: cert9.db, key4.db, pkcs11.txt), в git не попадают.
  Для CI секрет `TABORA_MAR_KEYS` = `tar -cz -C .build mar-keys | base64`. Потеря ключа означает,
  что установленные копии не примут новые пакеты: хранить резервную копию отдельно.
- **Адреса.** `tabora.update.url` — шаблон update.xml с подстановками движка
  (`%CHANNEL%`, `%BUILD_TARGET%`), `tabora.update.channelUrl` — манифест канала. Оба указывают на
  raw-файлы репозитория GitHub, пакеты лежат в GitHub Releases. Патч
  `src/toolkit/mozapps/update/UpdateService.sys.mjs.patch` подставляет `tabora.update.url` вместо
  зашитого адреса Mozilla.
- **Манифест канала** `updates/channel.json`:
  ```json
  { "release": { "version": "0.2.0", "minimum": "0.1.5", "notes": "…", "notesUrl": "…", "published": "2026-11-20" } }
  ```
  `version` выше текущей — обновление доступно; текущая ниже `minimum` — обновление **обязательное**.
- **Интерфейс** (`src/browser/base/content/tabora/update/`): необязательное — плашка внизу окна
  «Доступна версия … · Позже · Обновить/Перезапустить», напоминание раз в сутки; обязательное — экран
  поверх окна с прогрессом, ввод в браузер не проходит (кроме ⌘Q), по готовности «Перезапустить и
  установить». Проверка через 8 с после запуска и раз в час, вручную — в окне «О программе».

## Выпуск версии

1. Поднять `displayVersion` в `browser.json`, собрать и упаковать: `python3 tools/build.py build && python3 tools/build.py package`.
2. `python3 tools/release.py publish --minimum 0.1.0 --notes "Что нового"` — соберёт MAR из упакованного
   приложения (создав `precomplete` в копии), подпишет, проверит подпись, посчитает sha512, обновит
   `updates/channel.json` и `updates/<канал>/<цель>/update.xml`, создаст релиз `vX.Y.Z` на GitHub с MAR и dmg.
3. Закоммитить и запушить `updates/`: только после этого клиенты увидят обновление. Чтобы сделать его
   обязательным задним числом, достаточно поднять `minimum` в `channel.json`.
4. В CI то же делает workflow `Release` (нужны артефакт сборки и секрет с ключами).

## Проверка

- Юнит: `compareVersions` в `TaboraUpdate.sys.mjs`.
- Интерфейс: локальный `channel.json` с версией выше текущей (pref `tabora.update.channelUrl`), статусы
  обновлятора приходят из `AppUpdater`.
- Сквозная проверка установки возможна только на упакованном приложении (в сборке для разработки
  `canApplyUpdates = false`): установить dmg, выпустить тестовую версию, дождаться плашки.
