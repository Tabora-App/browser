#!/usr/bin/env bash
# Подпись и нотаризация Tabora для macOS: Developer ID, hardened runtime со штатными правами Firefox
# (mach macos-sign), нотаризация и staple приложения, затем dmg (тоже подписан и нотаризован).
# Берёт упакованное приложение после `BROWSER_RELEASE=1 tools/build.py package`.
#
#   tools/sign_macos.sh          подписать релизный пакет (нерелизный отвергается)
#   tools/sign_macos.sh --dev    подписать сборку для разработки: файлы получают суффикс -dev,
#                                распространять их нельзя
#
# Перед подписью пакет проверяет `tools/build.py verify`: релизная конфигурация (MOZILLA_OFFICIAL,
# без удалённой отладки), нет отчётов о сбоях и телеметрии, SourceStamp = HEAD, чистое дерево,
# Team ID в Info.plist и в обновляторе — наш (macTeamId в browser.json). После подписи проверяются
# codesign --verify --deep --strict, hardened runtime и TeamIdentifier каждого исполняемого файла,
# требования к привилегированному помощнику обновления и оценка Gatekeeper (spctl).
# Настройки через окружение:
#   TABORA_SIGN_IDENTITY   имя сертификата Developer ID Application в связке ключей
#   TABORA_NOTARY_KEY      путь к AuthKey_XXXX.p8 (App Store Connect), TABORA_NOTARY_KEY_ID, TABORA_NOTARY_ISSUER
# либо файл ~/.config/tabora/signing.env с этими переменными (права 600).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=""
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    *) echo "неизвестный аргумент: $arg (допустим только --dev)" >&2; exit 2 ;;
  esac
done
[ -f "$HOME/.config/tabora/signing.env" ] && . "$HOME/.config/tabora/signing.env"
: "${TABORA_SIGN_IDENTITY:?нет TABORA_SIGN_IDENTITY}" "${TABORA_NOTARY_KEY:?нет TABORA_NOTARY_KEY}" "${TABORA_NOTARY_KEY_ID:?}" "${TABORA_NOTARY_ISSUER:?}"
ARCH=${TARGET_ARCH:-aarch64}
OBJ="$ROOT/engine/obj-darwin-$ARCH"
SRC="$OBJ/dist/tabora/Tabora.app"
OUT="$ROOT/.build/signed"
VERSION=$(python3 -c "import json;c=json.load(open('$ROOT/browser.json'));print(c['brands'][c['brand']]['displayVersion'])")
WANT_TEAM=$(python3 -c "import json;print(json.load(open('$ROOT/browser.json')).get('macTeamId',''))")
TEAM=$(printf '%s' "$TABORA_SIGN_IDENTITY" | sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/')
MOZILLA_TEAM=43AQ936H96
SUFFIX=${DEV:+-dev}
log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
notary() { xcrun notarytool submit "$1" --key "$TABORA_NOTARY_KEY" --key-id "$TABORA_NOTARY_KEY_ID" --issuer "$TABORA_NOTARY_ISSUER" --wait --timeout 45m; }

[ -d "$SRC" ] || fail "нет $SRC: сначала BROWSER_RELEASE=1 tools/build.py package"
[[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || fail "в TABORA_SIGN_IDENTITY нет Team ID в скобках: $TABORA_SIGN_IDENTITY"
[ "$TEAM" = "$WANT_TEAM" ] || fail "Team ID сертификата ($TEAM) не совпадает с macTeamId в browser.json ($WANT_TEAM): помощник обновления собран под другой Team ID"

# Релизный ли пакет: без --dev любой признак сборки для разработки останавливает подпись
log "проверка пакета перед подписью"
# (последняя строка вывода verify: release | dev; ошибки пакета verify печатает сам и выходит с кодом 1)
VERIFY_OUT=$(cd "$ROOT" && TARGET_PLATFORM=darwin TARGET_ARCH="$ARCH" python3 tools/build.py verify ${DEV:+--dev} --app "$SRC") \
  || fail "пакет не прошёл проверку: подпись отменена${DEV:+ (эти ошибки не снимаются флагом --dev)}. Сборку для разработки подписывает только tools/sign_macos.sh --dev"
printf '%s\n' "$VERIFY_OUT"
KIND=$(printf '%s\n' "$VERIFY_OUT" | tail -1)
if [ -z "$DEV" ] && [ "$KIND" != "release" ]; then
  fail "пакет не релизный: подпись отменена (для пробной подписи: tools/sign_macos.sh --dev)"
fi
if [ -n "$DEV" ]; then
  warn "ПОДПИСЬ СБОРКИ ДЛЯ РАЗРАБОТКИ (--dev, пакет: $KIND): результат не распространять"
fi

rm -rf "$OUT"; mkdir -p "$OUT"
log "копия приложения"
ditto "$SRC" "$OUT/Tabora.app"
xattr -cr "$OUT/Tabora.app"
# Team ID Mozilla не должен остаться в требованиях подписи: Info.plist приложения и помощников,
# встроенный Info.plist обновлятора. Раньше его заменяли здесь sed только в Info.plist приложения;
# теперь требования собираются с нашим Team ID (TABORA_MAC_TEAM_ID в configure, macTeamId).
LEFT=$(grep -rl "$MOZILLA_TEAM" "$OUT/Tabora.app/Contents/Info.plist" "$OUT/Tabora.app/Contents/Library" \
  "$OUT/Tabora.app/Contents/MacOS/updater.app" 2>/dev/null || true)
if [ -n "$LEFT" ]; then
  printf '%s\n' "$LEFT" >&2
  fail "в требованиях подписи остался Team ID Mozilla ($MOZILLA_TEAM): пересоберите после tools/build.py import"
fi
grep -q "$TEAM" "$OUT/Tabora.app/Contents/Info.plist" || fail "в Info.plist нет Team ID $TEAM в SMPrivilegedExecutables"

log "подпись: $TABORA_SIGN_IDENTITY, hardened runtime"
(cd "$ROOT/engine" && MOZCONFIG="$ROOT/engine/mozconfig" MOZ_NOSPAM=1 ./mach macos-sign -a "$OUT/Tabora.app" -s "$TABORA_SIGN_IDENTITY" -e production-without-restricted -c release)

# Проверка подписи до нотаризации: каждая ошибка останавливает выпуск
verify_signature() {
  local app="$1" info flags team kind bad=0 f
  log "проверка подписи: $app"
  codesign --verify --deep --strict --verbose=2 "$app" || fail "codesign --verify --deep --strict не прошёл"
  # каждый исполняемый Mach-O: наш Team ID и hardened runtime
  while IFS= read -r -d '' f; do
    kind=$(file -b "$f")
    case "$kind" in *Mach-O*) ;; *) continue ;; esac
    info=$(codesign -dv --verbose=4 "$f" 2>&1) || { warn "не подписан: $f"; bad=1; continue; }
    team=$(printf '%s\n' "$info" | sed -n 's/^TeamIdentifier=//p')
    flags=$(printf '%s\n' "$info" | sed -n 's/^CodeDirectory .*flags=\([^ ]*\).*/\1/p')
    if [ "$team" != "$TEAM" ]; then warn "TeamIdentifier=$team (нужен $TEAM): $f"; bad=1; fi
    # библиотекам флаг runtime не обязателен, исполняемым файлам — обязателен
    case "$kind" in *executable*)
      case "$flags" in *runtime*) ;; *) warn "нет hardened runtime (flags=$flags): $f"; bad=1 ;; esac ;;
    esac
    case "$info" in *Signature=adhoc*) warn "ad-hoc подпись: $f"; bad=1 ;; esac
  done < <(find "$app" -type f \( -perm -u+x -o -name '*.dylib' \) -print0)
  [ "$bad" = 0 ] || fail "подпись не соответствует требованиям (см. выше)"
  info=$(codesign -dv --verbose=4 "$app" 2>&1)
  grep -E "^(Identifier|TeamIdentifier|Authority|Timestamp|CodeDirectory)" <<<"$info" || true
  grep -q "^Authority=Developer ID Application" <<<"$info" || fail "приложение подписано не сертификатом Developer ID Application"
  grep -q "^Timestamp=" <<<"$info" || fail "в подписи нет защищённой метки времени"
  # привилегированный помощник обновления должен удовлетворять требованию из Info.plist приложения,
  # а приложение — требованию SMAuthorizedClients помощника; иначе обновление с повышением прав
  # откажет (безопасно), и /Applications вне прав пользователя не обновится
  local helper="$app/Contents/Library/LaunchServices/org.mozilla.updater" bundle
  bundle=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist")
  local tail_req="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"$TEAM\""
  if [ -f "$helper" ]; then
    codesign --verify -R="identifier \"org.mozilla.updater\" and $tail_req" "$helper" 2>/dev/null \
      || warn "помощник обновления не удовлетворяет SMPrivilegedExecutables: обновление с повышением прав работать не будет"
    codesign --verify -R="identifier \"$bundle\" and $tail_req" "$app" 2>/dev/null \
      || warn "приложение не удовлетворяет SMAuthorizedClients помощника: обновление с повышением прав работать не будет"
  fi
}
verify_signature "$OUT/Tabora.app"

log "нотаризация приложения"
ditto -c -k --keepParent "$OUT/Tabora.app" "$OUT/Tabora.zip"
notary "$OUT/Tabora.zip"
xcrun stapler staple "$OUT/Tabora.app"
xcrun stapler validate "$OUT/Tabora.app"
rm -f "$OUT/Tabora.zip"
# staple не должен ломать подпись
codesign --verify --deep --strict "$OUT/Tabora.app" || fail "подпись повреждена после staple"

log "dmg"
DMG="$OUT/Tabora-$VERSION-mac-$ARCH$SUFFIX.dmg"
STAGE="$OUT/dmg"; mkdir -p "$STAGE"
ditto "$OUT/Tabora.app" "$STAGE/Tabora.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Tabora" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --sign "$TABORA_SIGN_IDENTITY" --timestamp "$DMG"
notary "$DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

log "проверка Gatekeeper"
spctl --assess --type execute -vv "$OUT/Tabora.app" >"$OUT/spctl-app.txt" 2>&1 || true
head -3 "$OUT/spctl-app.txt"
{ grep -q "accepted" "$OUT/spctl-app.txt" && grep -q "source=Notarized Developer ID" "$OUT/spctl-app.txt" && grep -q "($TEAM)" "$OUT/spctl-app.txt"; } \
  || fail "Gatekeeper не принял приложение (см. $OUT/spctl-app.txt)"
spctl --assess --type open --context context:primary-signature -vv "$DMG" >"$OUT/spctl-dmg.txt" 2>&1 || true
head -3 "$OUT/spctl-dmg.txt"
{ grep -q "accepted" "$OUT/spctl-dmg.txt" && grep -q "($TEAM)" "$OUT/spctl-dmg.txt"; } \
  || fail "Gatekeeper не принял dmg (см. $OUT/spctl-dmg.txt)"
codesign --verify --strict "$DMG" || fail "подпись dmg не проверяется"
rm -f "$OUT/spctl-app.txt" "$OUT/spctl-dmg.txt"
if [ -n "$DEV" ]; then
  warn "готово (СБОРКА ДЛЯ РАЗРАБОТКИ, не распространять): $DMG"
else
  log "готово: $DMG"
fi
