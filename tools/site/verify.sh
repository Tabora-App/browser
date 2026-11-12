#!/bin/sh
# Проверка воспроизводимости сайта: пересборка в чистом каталоге и побайтное сравнение
# с закоммиченными site/assets/js, site/site.js и страницами site/index.html, site/<язык>/index.html.
# Заодно пересборка проверяет сами страницы: переводы всех фраз, совпадение разметки на всех языках,
# местные ссылки (см. pages.mjs).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$here/package.json" "$here/package-lock.json" "$here/build.sh" "$here/pages.mjs" "$here/src" "$here/pages" "$tmp/"
SITE_I18N="$root/i18n/site" SITE_FILES="$root/site" sh "$tmp/build.sh" "$tmp/js" "$tmp/site.js" "$tmp/out"
ok=1
diff -r "$tmp/js" "$root/site/assets/js" >/dev/null || { ok=0; diff -rq "$tmp/js" "$root/site/assets/js" >&2 || true; }
diff "$tmp/site.js" "$root/site/site.js" >/dev/null || { ok=0; echo "site/site.js отличается" >&2; }
for page in $(cd "$tmp/out" && find . -name '*.html' | sed 's|^\./||' | sort); do
  diff "$tmp/out/$page" "$root/site/$page" >/dev/null 2>&1 || { ok=0; echo "site/$page отличается от собранной из шаблона" >&2; }
done
# в site/ не должно быть страниц, которых сборка не делает (правленных руками или от убранного языка)
for page in $(cd "$root/site" && find . -name '*.html' | sed 's|^\./||' | sort); do
  [ -f "$tmp/out/$page" ] || { ok=0; echo "site/$page: сборка такой страницы не делает" >&2; }
done
if [ "$ok" = 1 ]; then
  echo "✓ site/assets/js, site/site.js и страницы сайта воспроизводятся"
else
  echo "✗ сайт не совпадает с пересобранным: запустите tools/site/build.sh" >&2
  exit 1
fi
