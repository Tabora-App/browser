#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Подпись приложения Tabora для Android ключом Tabora.
#
#   tools/android/sign.sh init                         создать ключ (один раз)
#   tools/android/sign.sh <неподписанный.apk> [итог.apk]  выровнять, подписать и проверить
#   tools/android/sign.sh cert                         отпечаток сертификата ключа
#
# Ключ лежит вне репозитория: ~/.config/tabora/android-keys (TABORA_ANDROID_KEYS_DIR), пароль
# хранилища — в файле password рядом (TABORA_ANDROID_KEYS_PASSWORD_FILE). Телефон принимает
# обновление приложения только с той же подписью, поэтому ключ один на всю жизнь приложения:
# потеря ключа = пользователям придётся ставить приложение заново. Держите копию ключа отдельно.
#
# Нужны Java 17+ (JAVA_HOME) и build-tools из Android SDK (ANDROID_HOME).
set -eu

KEYS="${TABORA_ANDROID_KEYS_DIR:-$HOME/.config/tabora/android-keys}"
STORE="$KEYS/tabora-release.p12"
PASS="${TABORA_ANDROID_KEYS_PASSWORD_FILE:-$KEYS/password}"
ALIAS=tabora

die() { echo "sign.sh: $*" >&2; exit 1; }

find_java() {
  for home in "${JAVA_HOME:-}" /opt/homebrew/opt/openjdk@17 /opt/homebrew/opt/openjdk /usr/lib/jvm/java-17-openjdk-amd64 \
      "$HOME"/.mozbuild/jdk/jdk-*; do
    if [ -n "$home" ] && [ -x "$home/bin/keytool" ]; then
      echo "$home"; return
    fi
  done
  die "не найдена Java 17+: задайте JAVA_HOME"
}

find_tools() {
  for sdk in "${ANDROID_HOME:-}" "$HOME/Library/Android/sdk" "$HOME/.mozbuild/android-sdk-macosx" "$HOME/.mozbuild/android-sdk-linux"; do
    if [ -n "$sdk" ] && [ -d "$sdk/build-tools" ]; then
      dir=$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -1)
      if [ -x "$dir/apksigner" ] && [ -x "$dir/zipalign" ]; then
        echo "$dir"; return
      fi
    fi
  done
  die "не найдены build-tools Android SDK: задайте ANDROID_HOME"
}

JAVA_HOME=$(find_java)
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"
export PATH

case "${1:-}" in
  init)
    [ ! -e "$STORE" ] || die "ключ уже есть: $STORE (второй не создаётся — подпись приложения менять нельзя)"
    umask 077
    mkdir -p "$KEYS"
    [ -s "$PASS" ] || openssl rand -base64 30 > "$PASS"
    keytool -genkeypair -keystore "$STORE" -storetype PKCS12 -storepass:file "$PASS" -alias "$ALIAS" \
      -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10950 -dname "CN=Tabora, O=Tabora"
    chmod 600 "$STORE" "$PASS"
    echo "ключ создан: $STORE"
    keytool -list -v -keystore "$STORE" -storepass:file "$PASS" -alias "$ALIAS" | grep -E 'SHA256:|Valid from'
    ;;
  cert)
    [ -s "$STORE" ] || die "нет ключа: $STORE (сначала: tools/android/sign.sh init)"
    keytool -list -v -keystore "$STORE" -storepass:file "$PASS" -alias "$ALIAS" | grep -E 'SHA256:|Valid from'
    ;;
  ""|-h|--help)
    sed -n '6,16p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    in="$1"
    [ -f "$in" ] || die "нет файла $in"
    [ -s "$STORE" ] || die "нет ключа: $STORE (сначала: tools/android/sign.sh init)"
    out="${2:-$(echo "$in" | sed 's/-unsigned\.apk$/.apk/')}"
    [ "$out" != "$in" ] || out="${in%.apk}-signed.apk"
    tools=$(find_tools)
    tmp="$out.aligned"
    "$tools/zipalign" -f 4 "$in" "$tmp"
    "$tools/apksigner" sign --ks "$STORE" --ks-type PKCS12 --ks-pass "file:$PASS" --ks-key-alias "$ALIAS" \
      --out "$out" "$tmp"
    rm -f "$tmp" "$out.idsig"
    "$tools/apksigner" verify --print-certs "$out" | grep -E 'SHA-256|DN:' | head -2
    echo "подписано: $out"
    ;;
esac
