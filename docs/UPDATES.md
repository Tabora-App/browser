# Обновления Tabora

## Как устроено

Скачивание и установку делает штатный обновлятор движка: полный MAR-пакет, проверка подписи,
установка при перезапуске (staging в фоне). Своего загрузчика нет. Поверх него три уровня проверки.

### 1. Пакет (MAR) — проверяет обновлятор

- **Подпись.** MAR подписывается RSA-ключом Tabora (`tools/release.py` → `signmar`). Открытые
  сертификаты `release_primary.der` и `release_secondary.der` из `src/toolkit/mozapps/update/updater/`
  зашиваются в обновлятор вместо сертификатов Mozilla. Их SHA-256 закреплены в `tools/build.py`
  (`MAR_CERT_SHA256`): `import`, `build`, `package` и `release.py` останавливаются, если файлы в `src/`
  подменены (например, через PR).
- **Канал.** `MAR_CHANNEL_ID=tabora-release` (`configs/common/mozconfig`): пакет другого канала
  обновлятор отвергнет.
- **Версия Tabora.** В MAR записывается версия продукта = `displayVersion` из `browser.json`
  (а не версия Firefox). Обновлятор сравнивает её с версией Tabora, вшитой в него при сборке
  (`TABORA_APP_VERSION`: `browser/moz.configure.patch`, `updater-common.build.patch`, `updater.cpp.patch`),
  и не ставит пакет с версией ниже установленной — даже если он собран на той же версии Firefox
  и правильно подписан. Поэтому `displayVersion` поднимается при каждом выпуске; `release.py` не даст
  выпустить версию ниже или равную уже опубликованной для этой платформы (кроме `--replace`).
- **Проверка сборки перед выпуском.** `build.py package` и `release.py` проверяют упакованное
  приложение: в `updater.app/…/org.mozilla.updater` и `Library/LaunchServices/org.mozilla.updater`
  (Linux: `updater`) есть байты обоих наших DER, в `UpdateSettings.framework` (Linux: `update-settings.ini`)
  есть `tabora-release`, в `application.ini` нет адреса Mozilla, `tabora.version` в omni.ja совпадает с
  `browser.json`. Любое расхождение останавливает выпуск. Проверить вручную:
  `python3 tools/release.py check`.

### 2. Метаданные — подписанный манифест цели

Для каждой цели (канал + `%BUILD_TARGET%`, например `release/Darwin_aarch64-gcc3`) свой файл
`updates/<канал>/<цель>/manifest.json`:

```json
{
  "signed": "{\"channel\":\"release\",\"expires\":\"2027-02-07T12:00:00Z\",\"format\":1,…}",
  "signatures": [{ "keyid": "57b30cbe780889e7", "sig": "<Ed25519, base64>" }]
}
```

`signed` — JSON-текст, подпись Ed25519 считается по его байтам UTF-8 (без канонизации). Поля:
`format` (1), `channel`, `target`, `version`, `minimum`, `notes` (до 2000 символов), `notesUrl` (https),
`published` (дата), `expires` (UTC, по умолчанию +90 дней), `update` — пакет для этой цели:
`url` (https), `sha512`, `size`, `buildID`, `appVersion`.

- Клиент (`TaboraUpdate.sys.mjs`) проверяет подпись открытыми ключами из `MANIFEST_KEYS` (основной и
  запасной; заменяются только новой сборкой), затем поля: формат версий `X.Y.Z`, длины, https,
  `minimum ≤ version`, совпадение канала и цели.
- `update.xml` (`updates/<канал>/<цель>/update.xml`) сам не подписан, но UpdateService
  (`UpdateService.sys.mjs.patch`) принимает из него только `<update>`, совпадающий с `update` из
  проверенного манифеста: `taboraVersion`, `buildID`, `appVersion`, адрес, размер и sha512 пакета.
  Обновление с версией Tabora не выше установленной отбрасывается. Без действительного манифеста
  обновлений нет.
- **Срок действия** защищает от заморозки: если манифест просрочен (новые не приходят), «О программе»
  показывает «Сведения об обновлениях устарели». Поэтому манифесты нужно переподписывать не реже,
  чем раз в срок, даже без выпуска: `python3 tools/release.py refresh` и пуш `updates/`.
- `updates/channel.json` — старый общий манифест для сборок до этой схемы. Их обновлятор не принимает
  наши пакеты (старые сертификаты), поэтому `release.py` пишет туда только версию и заметки, а
  `minimum` не поднимает: старые копии видят новую версию и ставятся с сайта, но не блокируются.

### 3. Адреса

`tabora.update.url` (шаблон update.xml) и `tabora.update.manifestUrl` (шаблон манифеста) читаются
только из **настроек по умолчанию** (`Services.prefs.getDefaultBranch("")`): значение, заданное
пользователем, в about:config или user.js, не действует. Только https; ответ с другого хоста
(перенаправление) не принимается. Адрес из `application.ini` не используется вовсе (там теперь
`https://tabora.app/…` вместо aus5.mozilla.org, `updateHost` в `browser.json`); запасного адреса нет.
Политика `AppUpdateURL` учитывается, только если это https, и всё равно проходит сверку с манифестом.

### Обязательное обновление

Текущая версия ниже `minimum` из проверенного манифеста — обновление обязательное, но экран-стена
показывается, только если: для этой цели в манифесте есть пакет с версией ≥ `minimum`; обновления не
отключены политикой; есть обновлятор и права на установку (`canUsuallyApplyUpdates`); штатный обновлятор
не ответил «обновлений нет», «только вручную», «система не поддерживается». Иначе — плашка, при
недоступном обновляторе с кнопкой «Скачать с сайта». На стене всегда есть «Скачать с сайта»
(адрес `app.update.url.manual`, только https из настроек по умолчанию), «Повторить», «Выйти»; ⌘Q / Ctrl+Q
работают, кнопки стены доступны с клавиатуры.

### Интерфейс

`src/browser/base/content/tabora/update/`: необязательное — плашка внизу окна «Доступна версия … ·
Позже · Обновить/Перезапустить», напоминание раз в сутки; обязательное — экран поверх окна с прогрессом.
Проверка через 8 с после запуска и раз в час, вручную — в окне «О программе».

## Ключи

Ключи лежат **вне репозитория**:

| Что | Где (по умолчанию) | Переменная |
|---|---|---|
| Основной ключ MAR (NSS: cert9.db, key4.db, pkcs11.txt) и ключ манифестов `manifest-ed25519.pem` | `~/.config/tabora/mar-keys` | `TABORA_MAR_KEYS_DIR` |
| Запасной ключ MAR и запасной ключ манифестов | `~/.config/tabora/mar-keys-secondary` | `TABORA_MAR_SECONDARY_KEYS_DIR` |
| Пароль NSS-базы и PEM (если задан) | — | `TABORA_MAR_KEYS_PASSWORD_FILE` |

`release.py` откажется работать с базой внутри репозитория или с каталогом, доступным другим
пользователям (нужны `chmod 700` на каталог и `600` на файлы).

- **Пароль.** signmar поддерживает NSS-базу с паролем: без `TABORA_MAR_KEYS_PASSWORD_FILE` он спросит
  пароль в терминале, в CI пароль подаётся из секрета через файл. Задать пароль (один раз, обе базы):
  ```sh
  DYLD_LIBRARY_PATH=engine/obj-darwin-aarch64/dist/bin engine/obj-darwin-aarch64/dist/bin/certutil -W -d sql:$HOME/.config/tabora/mar-keys
  DYLD_LIBRARY_PATH=engine/obj-darwin-aarch64/dist/bin engine/obj-darwin-aarch64/dist/bin/certutil -W -d sql:$HOME/.config/tabora/mar-keys-secondary
  # PEM-ключ манифестов — тем же паролем:
  openssl pkcs8 -topk8 -v2 aes-256-cbc -in ~/.config/tabora/mar-keys/manifest-ed25519.pem -out /tmp/m.pem && mv /tmp/m.pem ~/.config/tabora/mar-keys/manifest-ed25519.pem && chmod 600 ~/.config/tabora/mar-keys/manifest-ed25519.pem
  ```
- **Запасной ключ — офлайн.** Каталог `mar-keys-secondary` нужен только при утрате или компрометации
  основного (`release.py … --key secondary`). Храните его вне этой машины: зашифрованный носитель
  (например, образ APFS с шифрованием или VeraCrypt) в двух физических местах, с паролем; после переноса
  удалите копию с диска. В CI он не нужен и в секреты не кладётся.
- **Потеря обоих ключей** означает, что установленные копии не примут новые пакеты: только переустановка
  с сайта.
- **CI.** Секреты окружения `release`: `TABORA_MAR_KEYS` = `tar -cz -C ~/.config/tabora mar-keys | base64`
  (только основной каталог), при пароле — `TABORA_MAR_KEYS_PASSWORD`.
- **Смена ключа манифестов**: сгенерировать новый Ed25519, добавить его открытый ключ в `MANIFEST_KEYS`
  (`TaboraUpdate.sys.mjs`), выпустить сборку, и только когда она разойдётся — подписывать новым.
  `release.py` проверяет, что ключ, которым подписывается манифест, зашит в клиент.

## Выпуск версии

### Локально (macOS)

1. Поднять `displayVersion` в `browser.json`, собрать и упаковать:
   `python3 tools/build.py import && python3 tools/build.py build && python3 tools/build.py package`
   (package проверит обновлятор).
2. `python3 tools/release.py publish --minimum 0.1.0 --notes "Что нового"` — соберёт MAR из
   `engine/obj-*/dist/tabora/Tabora.app` (символические ссылки не разыменовываются и запрещены),
   подпишет основным ключом, проверит подпись по DER из `src/`, канал и версию в MAR, напишет
   `manifest.json`, `update.xml`, `channel.json`, создаст релиз `vX.Y.Z` на GitHub с MAR и dmg.
3. Закоммитить и запушить `updates/`: только после этого клиенты увидят обновление. Чтобы сделать
   обновление обязательным задним числом: `python3 tools/release.py manifest --minimum X.Y.Z` и пуш.

### В CI

1. Workflow **Build** (ветка main) → артефакт `tabora-<платформа>` с dmg и
   `tabora-app-<платформа>.tar` (упакованное приложение для MAR).
2. Workflow **Release** (только из main) с ID этого запуска:
   - `verify` — проверяет входные данные (minimum `^[0-9]+\.[0-9]+\.[0-9]+$`, notes до 2000) и через
     `gh api`, что запуск — успешный Build из main этого репозитория, коммит входит в main, артефакт есть;
   - `sign` (environment `release`) — собирает signmar из исходников Firefox (хеш закреплён в
     `browser.json`) и системной NSS, распаковывает приложение без ссылок, собирает и подписывает MAR,
     пишет манифесты; бинарники из артефакта не запускаются, ключи лежат в `$RUNNER_TEMP` с правами 600
     и удаляются в конце;
   - `publish` (без ключей) — релиз на GitHub и коммит манифестов этой цели в main.
   Все inputs передаются в скрипты только через `env:`.
3. Настройки репозитория (делает владелец): environment `release` с обязательным ревьюером и
   правилом «Deployment branches: только main»; секреты `TABORA_MAR_KEYS` (и `TABORA_MAR_KEYS_PASSWORD`)
   — секретами этого environment, а не репозитория. Если main защищена, разрешить `github-actions`
   пуш в `updates/` (или убрать шаг коммита и пушить вручную).

## Safe Browsing

Без ключа Google Safe Browsing провайдеры Google не работают (фишинг и вредоносные загрузки не
проверяются), а в настройках выводится предупреждение. Ключ подключается при сборке из файла:
`$TABORA_SAFEBROWSING_KEYFILE` или `~/.config/tabora/safebrowsing.key` (`configs/common/mozconfig`), в CI —
из секрета `SAFEBROWSING_API_KEY`.

Как получить ключ (владелец): Google Cloud Console → новый проект → «APIs & Services» → включить
**Safe Browsing API** → «Credentials» → «Create credentials» → API key → ограничить ключ этим API.
Ключ попадает в сборку открыто (как у Firefox), поэтому ограничение по API обязательно. Для
коммерческого продукта у Google есть отдельные условия (Web Risk API); Mozilla использует ключ по
договорённости с Google — проверьте условия перед выпуском. Сохранить:
`umask 077; printf '%s' 'КЛЮЧ' > ~/.config/tabora/safebrowsing.key` и добавить секрет в GitHub.

## Подпись дополнений и русский интерфейс

Обязательная подпись дополнений включена (`MOZ_REQUIRE_SIGNING` по умолчанию для релиза, неподписанные
области `app,system` не разрешаются). Раньше её снимали ради языкового пакета с нашим брендингом
(подпись Mozilla при замене файлов становится недействительной). Теперь перевод встраивается в саму
сборку: `build.py download`/`package` берут `ru` из монорепозитория `mozilla-l10n/firefox-l10n` на
ревизии из `browser/locales/l10n-changesets.json` (частичная выборка в `.build/l10n-central`, путь
передаётся `--with-l10n-base`), а `build.py package` вызывает `mach package-multi-locale --locales en-US ru`.
Брендинг для ru берётся из нашего `browser/branding/release/locales/en-US` (Tabora). В профилях, где
стоял старый неподписанный пакет `langpack-ru@firefox.mozilla.org`, он станет «неподтверждённым» и
отключится; интерфейс при этом остаётся русским из самой сборки.

## Переход со старых сборок

Сборки до этой схемы (dmg от 8 ноября и ранее) содержат обновлятор с сертификатами Mozilla и
`UpdateSettings` без канала — MAR Tabora они не примут (а `UpdateSettings.framework` пакет не
перезаписывает). Их нужно один раз переустановить из нового dmg; дальше обновления идут через MAR.

## Проверка

- Модуль: `node` + заглушки (подпись, поля, фильтр update.xml, адреса только из настроек по умолчанию).
- Упакованное приложение: `python3 tools/release.py check`.
- Подпись MAR: `signmar -T <mar>` (канал, версия), `signmar -D src/toolkit/mozapps/update/updater/release_primary.der -v <mar>`.
- Сквозная проверка установки возможна только на упакованном приложении (в сборке для разработки
  `canApplyUpdates = false`): установить dmg, выпустить тестовую версию, дождаться плашки.
- Вендорные бандлы: `sh tools/wallet-vendor/verify.sh`, `sh tools/vault-vendor/verify.sh`.
