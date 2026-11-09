#!/usr/bin/env bash
# Подпись и нотаризация Tabora для macOS: Developer ID, hardened runtime со штатными правами Firefox
# (mach macos-sign), нотаризация и staple приложения, затем dmg (тоже подписан и нотаризован).
# Берёт упакованное приложение после `tools/build.py package`. Настройки через окружение:
#   TABORA_SIGN_IDENTITY   имя сертификата Developer ID Application в связке ключей
#   TABORA_NOTARY_KEY      путь к AuthKey_XXXX.p8 (App Store Connect), TABORA_NOTARY_KEY_ID, TABORA_NOTARY_ISSUER
# либо файл ~/.config/tabora/signing.env с этими переменными (права 600).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$HOME/.config/tabora/signing.env" ] && . "$HOME/.config/tabora/signing.env"
: "${TABORA_SIGN_IDENTITY:?нет TABORA_SIGN_IDENTITY}" "${TABORA_NOTARY_KEY:?нет TABORA_NOTARY_KEY}" "${TABORA_NOTARY_KEY_ID:?}" "${TABORA_NOTARY_ISSUER:?}"
ARCH=${TARGET_ARCH:-aarch64}
OBJ="$ROOT/engine/obj-darwin-$ARCH"
SRC="$OBJ/dist/tabora/Tabora.app"
OUT="$ROOT/.build/signed"
VERSION=$(python3 -c "import json;c=json.load(open('$ROOT/browser.json'));print(c['brands'][c['brand']]['displayVersion'])")
TEAM=$(printf '%s' "$TABORA_SIGN_IDENTITY" | sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/')
log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
notary() { xcrun notarytool submit "$1" --key "$TABORA_NOTARY_KEY" --key-id "$TABORA_NOTARY_KEY_ID" --issuer "$TABORA_NOTARY_ISSUER" --wait --timeout 45m; }

[ -d "$SRC" ] || { echo "нет $SRC: сначала tools/build.py package"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
log "копия приложения"
ditto "$SRC" "$OUT/Tabora.app"
# в Info.plist остаётся Team ID Mozilla для привилегированных помощников: ставим свой
sed -i '' "s/43AQ936H96/$TEAM/g" "$OUT/Tabora.app/Contents/Info.plist"
xattr -cr "$OUT/Tabora.app"

log "подпись: $TABORA_SIGN_IDENTITY, hardened runtime"
(cd "$ROOT/engine" && MOZCONFIG="$ROOT/engine/mozconfig" MOZ_NOSPAM=1 ./mach macos-sign -a "$OUT/Tabora.app" -s "$TABORA_SIGN_IDENTITY" -e production-without-restricted -c release)
codesign --verify --deep --strict "$OUT/Tabora.app"
codesign -dv "$OUT/Tabora.app" 2>&1 | grep -E "TeamIdentifier|flags|Authority" || true

log "нотаризация приложения"
ditto -c -k --keepParent "$OUT/Tabora.app" "$OUT/Tabora.zip"
notary "$OUT/Tabora.zip"
xcrun stapler staple "$OUT/Tabora.app"
rm -f "$OUT/Tabora.zip"

log "dmg"
DMG="$OUT/Tabora-$VERSION-mac-$ARCH.dmg"
STAGE="$OUT/dmg"; mkdir -p "$STAGE"
ditto "$OUT/Tabora.app" "$STAGE/Tabora.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Tabora" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --sign "$TABORA_SIGN_IDENTITY" --timestamp "$DMG"
notary "$DMG"
xcrun stapler staple "$DMG"

log "проверка Gatekeeper"
spctl --assess --type execute -vv "$OUT/Tabora.app" 2>&1 | head -3
spctl --assess --type open --context context:primary-signature -vv "$DMG" 2>&1 | head -3
log "готово: $DMG"
