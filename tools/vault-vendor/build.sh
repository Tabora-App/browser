#!/bin/sh
# Пересборка вендорного бандла сейфа (версии зафиксированы в package.json)
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund --silent
npx esbuild entry.mjs --bundle --format=esm --platform=neutral --main-fields=module,main --target=es2022 \
  --outfile=../../src/browser/base/content/tabora/vault/vendor/qr.sys.mjs --legal-comments=none
