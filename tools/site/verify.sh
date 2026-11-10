#!/bin/sh
# Проверка воспроизводимости скриптов сайта: пересборка в чистом каталоге и побайтное сравнение
# с закоммиченными site/assets/js и site/site.js.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$here/package.json" "$here/package-lock.json" "$here/build.sh" "$here/src" "$tmp/"
sh "$tmp/build.sh" "$tmp/js" "$tmp/site.js"
ok=1
diff -r "$tmp/js" "$root/site/assets/js" >/dev/null || { ok=0; diff -rq "$tmp/js" "$root/site/assets/js" >&2 || true; }
diff "$tmp/site.js" "$root/site/site.js" >/dev/null || { ok=0; echo "site/site.js отличается" >&2; }
if [ "$ok" = 1 ]; then
  echo "✓ site/assets/js и site/site.js воспроизводятся"
else
  echo "✗ скрипты сайта не совпадают с пересобранными" >&2
  exit 1
fi
