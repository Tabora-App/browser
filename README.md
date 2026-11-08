# Browser

Браузер на базе Firefox с собственным интерфейсом, ИИ-агентом, встроенной почтой с алиасами и синхронизацией между устройствами.

Рабочее название. Исходники Firefox не хранятся в репозитории: инструмент `tools/build.py` скачивает нужную версию в `engine/`, накладывает поверх неё наш брендинг и изменения из `src/`, и вызывает штатную сборку Mozilla.

## Структура

- `browser.json` — версия Firefox, бренд, имя бинарника, адреса сайта.
- `tools/build.py` — инструмент сборки, только стандартная библиотека Python.
- `src/` — наши изменения: файлы зеркалят дерево Firefox. Правки существующих файлов лежат рядом как `*.patch`, новые файлы подключаются символическими ссылками, так что правка в `src/` сразу видна сборке.
- `configs/` — mozconfig для каждой платформы (`common`, `darwin`, `linux`) и брендинг (`configs/branding/release`).
- `.github/workflows/build.yml` — сборка на раннерах Blacksmith, macOS собирается кросс-компиляцией на Linux.
- `docs/` — архитектура и дорожная карта.

## Локальная сборка (macOS, Linux)

```sh
python3 tools/build.py download    # исходники Firefox в engine/
python3 tools/build.py import      # брендинг и src/
python3 tools/build.py bootstrap   # тулчейны Mozilla, один раз
python3 tools/build.py build       # полная сборка, 1,5-2 часа
python3 tools/build.py run         # запустить
```

После правок интерфейса: `python3 tools/build.py build --ui` и `run`.

Правки, сделанные прямо в `engine/`, превращаются в патчи командой `export`. Состояние показывает `status`, обновление Firefox делает `update`.

Релизная сборка: `BROWSER_RELEASE=1`. Кросс-сборка под другую платформу: `TARGET_PLATFORM=darwin TARGET_ARCH=aarch64`.

## Лицензия

MPL-2.0, как у Firefox.
