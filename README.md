# Browser

Браузер на базе Firefox с собственным интерфейсом, ИИ-агентом, встроенной почтой с алиасами и синхронизацией между устройствами.

Рабочее название. Исходники Firefox не хранятся в репозитории: инструмент Surfer скачивает нужную версию и накладывает поверх неё наши патчи из `src/`.

## Структура

- `surfer.json` — версия Firefox, бренд, имя бинарника.
- `src/` — наши изменения: файлы зеркалят дерево Firefox, правки существующих файлов лежат рядом как `.patch`, новый код в `src/browser/`.
- `configs/` — mozconfig для каждой платформы и брендинг (`configs/branding/release`).
- `.github/workflows/build.yml` — сборка на раннерах Blacksmith; macOS собирается кросс-компиляцией на Linux.
- `docs/` — архитектура и дорожная карта.

## Локальная сборка (macOS, Linux)

```sh
npm install
npm run download    # скачать исходники Firefox в engine/
npm run import      # наложить патчи и брендинг
npm run bootstrap   # поставить тулчейны Mozilla
npm run build       # полная сборка, 1,5-2 часа
npm run start       # запустить собранный браузер
```

После правок интерфейса достаточно `npm run build:ui` и `npm run start`.

Экспорт изменений, сделанных прямо в `engine/`, обратно в патчи: `npm run export`.

## Лицензия

MPL-2.0, как у Firefox.
