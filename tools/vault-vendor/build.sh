#!/bin/sh
# Пересборка вендорного бандла сейфа. Версии зафиксированы в package-lock.json; скрипты
# установки пакетов не запускаются. Аргумент — куда писать бандл (по умолчанию — в src/).
set -eu
cd "$(dirname "$0")"
out="${1:-../../src/browser/base/content/tabora/vault/vendor/qr.sys.mjs}"
npm ci --ignore-scripts --no-audit --no-fund --silent
./node_modules/.bin/esbuild entry.mjs --bundle --format=esm --platform=neutral --main-fields=module,main --target=es2022 \
  --outfile="$out" --legal-comments=none --log-level=warning
# Argon2id на WebAssembly для рабочего потока KDF (отдельный модуль: потоку не нужен jsQR)
argon="${2:-$(dirname "$out")/argon2.sys.mjs}"
./node_modules/.bin/esbuild argon2-entry.mjs --bundle --format=esm --platform=neutral --main-fields=module,main --target=es2022 \
  --outfile="$argon" --legal-comments=none --log-level=warning
