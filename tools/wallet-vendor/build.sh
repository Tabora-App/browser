#!/bin/sh
# Пересборка вендорного криптобандла кошелька (версии зафиксированы в package.json)
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund --silent
npx esbuild entry.mjs --bundle --format=esm --platform=neutral --main-fields=module,main --target=es2022 \
  --outfile=../../src/browser/base/content/tabora/wallet/vendor/crypto.sys.mjs --legal-comments=none
