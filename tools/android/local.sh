#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Местная сборка приложения Android без компиляции движка — для проверки правок интерфейса за
# минуты. Движок (библиотеки и omni.ja) берётся готовым: из файла приложения, собранного на
# GitHub, или из пакета GeckoView той же версии с maven.mozilla.org. Результат годится только
# для проверки в эмуляторе; выпуск собирает workflow Android.
#
#   tools/android/local.sh setup <движок.apk|.aar> [--mozilla]   настроить и положить движок
#   tools/android/local.sh build                                 собрать приложение
#   tools/android/local.sh compile                               только проверить, что Kotlin собирается
#
# --mozilla: движок собран Mozilla (со сборщиком отчётов о сбоях) — наша часть должна быть
# собрана так же, иначе движок падает при запуске. Для движка с GitHub флаг не нужен.
#
# Нужны: Android SDK (build-tools 37.0.0, platforms;android-37.2, cmdline-tools;23.0), Java 17,
# ~/.mozbuild/bundletool.jar (версия из engine/python/mozboot/mozboot/android.py), ~8 ГБ на диске.
# Каталог объектов свой (engine/obj-android-local): сборку для компьютера это не затрагивает.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENGINE="$ROOT/engine"
OBJ="$ENGINE/obj-android-local"
MOZCONFIG="$ROOT/.build/android-local.mozconfig"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAVA="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
VERSION="$(python3 -c "import json; c = json.load(open('$ROOT/browser.json')); print(c['brands'][c['brand']]['displayVersion'])")"
export MOZCONFIG MOZ_NOSPAM=1
# gradle берёт библиотеки движка из dist/geckoview, только если видит эту переменную
export MOZ_CHROME_MULTILOCALE=en-US

die() { echo "local.sh: $*" >&2; exit 1; }

gradle() {
  # память и число потоков ограничены, чтобы сборка не мешала работе на той же машине
  (cd "$ENGINE" && ./mach gradle "$@" "-PtaboraVersionName=$VERSION" -PdisableDebugSigning -PdisableOptimization \
    "-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=2g -XX:+UseParallelGC" -Pkotlin.daemon.jvmargs=-Xmx3g \
    --max-workers=5 --console=plain) > "$ROOT/.build/android-local-gradle.log" 2>&1 || {
      grep -n '^e: \|What went wrong\|error:' -A4 "$ROOT/.build/android-local-gradle.log" | head -40 | cut -c1-260
      die "сборка не удалась, журнал: .build/android-local-gradle.log"
    }
  grep 'BUILD SUCCESSFUL' "$ROOT/.build/android-local-gradle.log"
}

case "${1:-}" in
  setup)
    src="${2:-}"; [ -f "$src" ] || die "нет файла движка: $src"
    crash="ac_add_options --disable-crashreporter"
    [ "${3:-}" = "--mozilla" ] && crash="# движок Mozilla: со сборщиком отчётов о сбоях"
    [ -d "$SDK/build-tools" ] || die "нет Android SDK в $SDK (ANDROID_HOME)"
    [ -x "$JAVA/bin/java" ] || die "нет Java 17 в $JAVA (JAVA_HOME)"
    mkdir -p "$ROOT/.build"
    cat > "$MOZCONFIG" <<CONF
# Создано tools/android/local.sh: приложение Android без компиляции движка
mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-android-local
ac_add_options --enable-project=mobile/android
ac_add_options --target=aarch64-linux-android
ac_add_options --with-branding=mobile/android/branding/tabora
ac_add_options --enable-update-channel=release
ac_add_options --disable-compile-environment
# из готовых средств Mozilla нужны только два: без компиляции их неоткуда взять
ac_add_options --enable-bootstrap=embedded-uniffi-bindgen,nimbus-fml
ac_add_options --with-android-sdk=$SDK
ac_add_options --with-java-bin-path=$JAVA/bin
$crash
ac_add_options MOZ_TELEMETRY_REPORTING=
mk_add_options MOZILLA_OFFICIAL=1
MOZILLA_OFFICIAL=1
export MOZILLA_OFFICIAL=1
export MOZ_SOURCE_REPO=https://github.com/Tabora-App/browser
export MOZ_SOURCE_CHANGESET=local
export MOZ_INCLUDE_SOURCE_INFO=1
CONF
    (cd "$ENGINE" && ./mach configure > "$ROOT/.build/android-local-configure.log" 2>&1) \
      || { tail -5 "$ROOT/.build/android-local-configure.log"; die "настройка не удалась"; }
    (cd "$ENGINE" && ./mach build pre-export export > "$ROOT/.build/android-local-export.log" 2>&1) \
      || die "подготовительный шаг не удался, журнал: .build/android-local-export.log"
    gv="$OBJ/dist/geckoview"
    rm -rf "$gv/lib/arm64-v8a" "$gv/assets/omni.ja"
    mkdir -p "$gv/lib/arm64-v8a" "$gv/assets"
    case "$src" in
      *.aar) unzip -o -q -j "$src" 'jni/arm64-v8a/*' -d "$gv/lib/arm64-v8a" ;;
      *) unzip -o -q -j "$src" 'lib/arm64-v8a/*' -d "$gv/lib/arm64-v8a" ;;
    esac
    unzip -o -q -j "$src" 'assets/omni.ja' -d "$gv/assets"
    [ -f "$gv/lib/arm64-v8a/libxul.so" ] || die "в $src нет движка (libxul.so для arm64-v8a)"
    # название в надписях — как в настоящей сборке
    (cd "$ROOT" && python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('build', 'tools/build.py'); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
b.rebrand_android_strings()")
    echo "готово: движок из $(basename "$src"), дальше — tools/android/local.sh build"
    ;;
  build)
    [ -f "$OBJ/dist/geckoview/lib/arm64-v8a/libxul.so" ] || die "сначала: tools/android/local.sh setup <движок>"
    gradle fenix:assembleRelease
    ls "$OBJ"/gradle/build/mobile/android/fenix/app/outputs/apk/release/*arm64-v8a*.apk
    ;;
  compile)
    [ -f "$OBJ/config.status" ] || die "сначала: tools/android/local.sh setup <движок>"
    gradle fenix:compileReleaseKotlin
    ;;
  *)
    sed -n '6,20p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
