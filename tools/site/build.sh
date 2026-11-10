#!/bin/sh
# Сборка скриптов сайта: src/ → site/assets/js/ (имена с хешем: nginx отдаёт /assets/ как immutable)
# и site/site.js — точка входа в корне, одна строка с импортом собранного main-ХЕШ.js.
# Версии закреплены в package-lock.json, скрипты установки пакетов не запускаются.
# Аргументы: каталог вывода (по умолчанию site/assets/js) и файл точки входа (site/site.js).
# SITE_SKIP_INSTALL=1 пропускает npm ci (для быстрых пересборок при уже установленных пакетах).
set -eu
cd "$(dirname "$0")"
out="${1:-../../site/assets/js}"
entry="${2:-../../site/site.js}"
[ -n "${SITE_SKIP_INSTALL:-}" ] || npm ci --ignore-scripts --no-audit --no-fund --silent
rm -rf "$out"
./node_modules/.bin/esbuild src/main.js --bundle --splitting --format=esm --platform=browser --target=es2022 \
  --minify --legal-comments=eof '--entry-names=[name]-[hash]' '--chunk-names=chunk-[hash]' \
  --outdir="$out" --log-level=warning
main="$(cd "$out" && ls main-*.js)"
[ "$(printf '%s\n' "$main" | wc -l | tr -d ' ')" = 1 ] || { echo "ожидался один main-*.js, найдено: $main" >&2; exit 1; }
printf 'import "./assets/js/%s";\n' "$main" > "$entry"
