#!/bin/sh
# Проверка воспроизводимости: бандлы собираются заново в чистом каталоге из package.json,
# package-lock.json и точек входа и сравниваются побайтно с закоммиченными
# src/browser/base/content/tabora/vault/vendor/qr.sys.mjs и argon2.sys.mjs.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
vendor="$root/src/browser/base/content/tabora/vault/vendor"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/package.json" "$here/package-lock.json" "$here/entry.mjs" "$here/argon2-entry.mjs" "$here/build.sh" "$tmp/"
sh "$tmp/build.sh" "$tmp/qr.sys.mjs" "$tmp/argon2.sys.mjs"
status=0
for name in qr.sys.mjs argon2.sys.mjs; do
  want="$(shasum -a 256 "$vendor/$name" | cut -d' ' -f1)"
  got="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"
  if [ "$want" != "$got" ]; then
    echo "✗ vault/vendor/$name не совпадает с пересобранным: $want != $got" >&2
    status=1
  else
    echo "✓ vault/vendor/$name воспроизводится (sha256 $got)"
  fi
done
exit $status
