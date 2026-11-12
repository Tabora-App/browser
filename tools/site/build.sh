#!/bin/sh
# Сборка сайта: скрипты и страницы.
# Скрипты: src/ → site/assets/js/ (имена с хешем: nginx отдаёт /assets/ как immutable)
# и site/site.js — точка входа в корне, одна строка с импортом собранного main-ХЕШ.js.
# Страницы: русский шаблон pages/index.html и словари i18n/site/*.json → site/<язык>/index.html
# и site/index.html (см. pages.mjs). В site/ лежит только готовое; текст страницы правится в шаблоне.
# Версии закреплены в package-lock.json, скрипты установки пакетов не запускаются.
# Аргументы: каталог скриптов (по умолчанию site/assets/js), файл точки входа (site/site.js)
# и каталог страниц (site).
# SITE_SKIP_INSTALL=1 пропускает npm ci (для быстрых пересборок при уже установленных пакетах).
# SITE_I18N — каталог словарей (по умолчанию i18n/site), SITE_FILES — каталог сайта, по которому
# проверяются местные ссылки страниц (по умолчанию каталог страниц).
set -eu
cd "$(dirname "$0")"
out="${1:-../../site/assets/js}"
entry="${2:-../../site/site.js}"
pages="${3:-../../site}"
[ -n "${SITE_SKIP_INSTALL:-}" ] || npm ci --ignore-scripts --no-audit --no-fund --silent
rm -rf "$out"
./node_modules/.bin/esbuild src/main.js --bundle --splitting --format=esm --platform=browser --target=es2022 \
  --minify --legal-comments=eof '--entry-names=[name]-[hash]' '--chunk-names=chunk-[hash]' \
  --outdir="$out" --log-level=warning
main="$(cd "$out" && ls main-*.js)"
[ "$(printf '%s\n' "$main" | wc -l | tr -d ' ')" = 1 ] || { echo "ожидался один main-*.js, найдено: $main" >&2; exit 1; }
printf 'import "./assets/js/%s";\n' "$main" > "$entry"
node pages.mjs "$pages" --i18n "${SITE_I18N:-../../i18n/site}" --files "${SITE_FILES:-$pages}"
