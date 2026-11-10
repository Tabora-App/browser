#!/bin/sh
# OpenPGP.js для почты Tabora. Библиотека не пересобирается: в дерево src/ кладётся готовый
# файл из пакета npm (браузерная сборка одним модулем) и текст лицензии. Версия и хеш пакета
# закреплены в package.json и package-lock.json; скрипты установки пакетов не запускаются.
# Аргумент — каталог, куда писать (по умолчанию — в дерево src/).
set -eu
cd "$(dirname "$0")"
out="${1:-../../src/browser/base/content/tabora/mail/pgp}"
npm ci --ignore-scripts --no-audit --no-fund --silent
mkdir -p "$out"
cp node_modules/openpgp/dist/openpgp.mjs "$out/openpgp.mjs"
cp node_modules/openpgp/LICENSE "$out/LICENSE.openpgp.txt"
