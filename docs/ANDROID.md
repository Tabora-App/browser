# Tabora для Android

Приложение для Android собирается из того же дерева исходников Firefox, что и браузер для
компьютера: движок GeckoView и приложение `mobile/android/fenix`. Наши изменения лежат там же,
где и остальные, — в `src/` (зеркало дерева движка, `tools/build.py import`).

Состояние: первая версия — браузер под именем Tabora со встроенным блокировщиком рекламы и без
сервисов Mozilla. Разделов аккаунта Tabora (почта, пароли, коды) и кошелька в приложении пока нет.

## Что изменено

| Что | Где |
| --- | --- |
| Имя пакета `app.tabora.browser`, без общего пользователя с Firefox, ссылки `tabora://` | `src/mobile/android/fenix/app/build.gradle.patch`, `src/release/AndroidManifest.xml.patch`, `src/release/res/xml/shortcuts.xml.patch` |
| Название в надписях («Firefox» → «Tabora» во всех переводах) | `rebrand_android_strings` в `tools/build.py` — по месту, только для цели android |
| Значок, заставка, знак в уведомлениях, знак и надпись на стартовой странице | `src/mobile/android/fenix/app/src/{main,release}/res/…`; рисует `tools/android/assets.py` |
| Названия для движка (страницы ошибок) | `src/mobile/android/branding/tabora/` |
| Блокировщик рекламы — те же модули, что на компьютере | `src/mobile/shared/tabora/jar.mn`, запуск в `GeckoViewStartup.sys.mjs.patch` |
| Ярлыки стартовой страницы | `src/main/res/raw/default_shortcuts.json`, `default_pinned_shortcuts.json` |

### Что не уходит в Mozilla

- Движок: без сборщика отчётов о сбоях и без телеметрии (`configs/android/mozconfig`), выгрузка
  Glean из движка выключена тем же патчем, что на компьютере.
- Приложение: `TELEMETRY` и `CRASH_REPORTING` выключены сборкой (`build.gradle.patch`) — службы
  сбора данных, Adjust и сведения об источнике установки не запускаются; отправка данных по
  умолчанию выключена (`Settings.kt.patch`); отчёты о сбоях не собираются и не предлагаются
  (`Analytics.kt.patch`).
- Эксперименты и удалённые изменения Mozilla (Nimbus) не загружаются, вшитый список пуст
  (`NimbusSetup.kt.patch`, `initial_experiments.json`).
- Первый экран с условиями Mozilla не показывается (`FeatureFlags.kt.patch`).
- Рекомендации и рекламные материалы на стартовой странице, рекламные ярлыки выключены
  (`nimbus.fml.yaml.patch`, `Settings.kt.patch`).
- Уведомления через Firebase не работают: в сборке нет его настроек.
- Настройки движка (`src/mobile/android/app/geckoview-prefs.js.patch`): телеметрия, проверка
  «портала авторизации», определение страны, отправка списка дополнений и VPN Mozilla выключены —
  те же решения, что в `configs/prefs/release.js` для компьютера.

### Что убрано из интерфейса

Войти в аккаунт Mozilla в приложении негде: пункт входа убран из настроек, главного меню, списка
вкладок (страница «Синхронизированные вкладки»), пустого экрана закладок, «Поделиться» («Отправить
на устройство») и настроек паролей, карт и адресов. Скрыты «Сбор данных», «Оценить в Google Play»,
лаборатория, «Удалённые улучшения», выбор значка приложения (значки Firefox), VPN Mozilla и пересказ
страницы (требует аккаунт Mozilla). В «О приложении» остались лицензии и список библиотек.
Встроенные сообщения «сделайте браузером по умолчанию» выключены.

Правки Kotlin сделаны так, чтобы менять как можно меньше: значение по умолчанию, условие показа,
элемент списка. Сборка идёт с «предупреждения = ошибки», а проверить её можно только на GitHub.

Ещё не сделано (следующие шаги): цвета оформления (у Firefox фиолетовая палитра), выключатель
блокировщика рекламы в настройках, ссылка «Кто может видеть мои действия» в приватном режиме
(ведёт в справку Mozilla), «Сообщить о проблеме с сайтом», библиотеки Google (Firebase, Play
Services) в составе приложения, картинки прежних значков Firefox внутри файла приложения.

## Сборка

Локально нужна машина с ~40 ГБ свободного места; обычно сборка идёт на GitHub: workflow
**Android** (`.github/workflows/android.yml`), запуск вручную, около двух часов.

```sh
export TARGET_PLATFORM=android TARGET_ARCH=aarch64 BROWSER_RELEASE=1
python3 tools/build.py download
python3 tools/build.py import      # патчи, файлы src/, название в надписях
python3 tools/build.py bootstrap   # тулчейны Mozilla, Android SDK, NDK, JDK в ~/.mozbuild
python3 tools/build.py build       # движок, затем приложение (gradle fenix:assembleRelease)
python3 tools/build.py package     # проверка и dist/tabora-<версия>-android-arm64-v8a-unsigned.apk
```

`package` проверяет готовый файл: имя пакета, отсутствие общего пользователя с Firefox, наличие
движка и модулей блокировщика внутри `omni.ja`, отсутствие чужой подписи.

Версия приложения — `displayVersion` из `browser.json` (та же, что у браузера для компьютера).
Номер сборки (versionCode) растёт со временем сам.

## Подпись

Сборка отдаёт неподписанный файл; ключа подписи в CI нет. Подпись — на своей машине:

```sh
tools/android/sign.sh init                       # один раз: создать ключ
tools/android/sign.sh dist/tabora-…-unsigned.apk # выровнять, подписать, проверить
```

Ключ: `~/.config/tabora/android-keys` (`TABORA_ANDROID_KEYS_DIR`). Телефон принимает обновление
только с той же подписью, поэтому ключ один на всю жизнь приложения — держите его копию отдельно.

## Проверка в эмуляторе

```sh
adb install -r dist/tabora-…-android-arm64-v8a.apk
adb shell monkey -p app.tabora.browser -c android.intent.category.LAUNCHER 1
```
