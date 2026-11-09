#!/bin/sh
# Проверка воспроизводимости: бандл собирается заново в чистом каталоге из package.json,
# package-lock.json и entry.mjs и сравнивается побайтно с закоммиченным src/browser/base/content/tabora/vault/vendor/qr.sys.mjs.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
committed="$root/src/browser/base/content/tabora/vault/vendor/qr.sys.mjs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/package.json" "$here/package-lock.json" "$here/entry.mjs" "$here/build.sh" "$tmp/"
sh "$tmp/build.sh" "$tmp/rebuilt.sys.mjs"
want="$(shasum -a 256 "$committed" | cut -d' ' -f1)"
got="$(shasum -a 256 "$tmp/rebuilt.sys.mjs" | cut -d' ' -f1)"
if [ "$want" != "$got" ]; then
  echo "✗ src/browser/base/content/tabora/vault/vendor/qr.sys.mjs не совпадает с пересобранным: $want != $got" >&2
  exit 1
fi
echo "✓ src/browser/base/content/tabora/vault/vendor/qr.sys.mjs воспроизводится (sha256 $got)"
