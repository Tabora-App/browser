#!/bin/sh
# Проверка происхождения: пакет ставится заново в чистом каталоге по package-lock.json (npm сверяет
# хеш пакета), и файлы в src/ сравниваются побайтно с файлами из него.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dir="$root/src/browser/base/content/tabora/mail/pgp"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/package.json" "$here/package-lock.json" "$here/build.sh" "$tmp/"
sh "$tmp/build.sh" "$tmp/out"
for f in openpgp.mjs LICENSE.openpgp.txt; do
  want="$(shasum -a 256 "$dir/$f" | cut -d' ' -f1)"
  got="$(shasum -a 256 "$tmp/out/$f" | cut -d' ' -f1)"
  if [ "$want" != "$got" ]; then
    echo "✗ $f в src/ не совпадает с файлом из пакета: $want != $got" >&2
    exit 1
  fi
  echo "✓ $f совпадает с пакетом openpgp (sha256 $got)"
done
