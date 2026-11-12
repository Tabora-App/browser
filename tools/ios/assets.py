#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Картинки Tabora для приложения iPhone вместо логотипов Firefox.

Рисует знак (лаймовый квадрат с монограммой T — те же числа, что в web/static/icons/mark.svg)
и кладёт результат в каталог ios/…: оттуда tools/ios/build.py import подключает файлы поверх картинок
Firefox для iOS. Запускать нужно только при смене знака; готовые файлы лежат в репозитории.

Нужны: Python с Pillow и Playwright с Chromium.

    python3 tools/ios/assets.py
"""
import base64
import io
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "ios"
TREE = ROOT / ".build" / "ios" / "firefox-ios"  # исходники Firefox для iOS: по ним берутся размеры картинок
FONT = ROOT / "src" / "browser" / "base" / "content" / "tabora" / "fonts" / "Manrope-latin.woff2"
CLIENT = "firefox-ios/Client/Assets/"
LIME = "#c8f25a"
INK = "#0b0c0e"


def t_shapes(bar: str, dot: str) -> str:
    """Монограмма в поле 256×256: перекладина, ножка и точка на перекладине."""
    return (f'<rect x="56" y="66" width="144" height="38" rx="19" fill="{bar}"/>'
            f'<rect x="109" y="66" width="38" height="134" rx="19" fill="{bar}"/>'
            f'<circle cx="181" cy="85" r="11" fill="{dot}"/>')


def svg(body: str, size: int) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="{size}" height="{size}">{body}</svg>'


def render(browser, markup: str, size: int, scale: float = 1) -> Image.Image:
    ctx = browser.new_context(device_scale_factor=scale, viewport={"width": size, "height": size})
    page = ctx.new_page()
    page.set_content(f'<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{display:block}}</style>{markup}')
    png = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
    ctx.close()
    return Image.open(io.BytesIO(png)).convert("RGBA")


def save(im: Image.Image, rel: str) -> None:
    out = OUT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "PNG", optimize=True)
    print(f"  {rel}  {im.width}×{im.height} {im.mode}")


def write(rel: str, text: str) -> None:
    out = OUT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"  {rel}")


def app_icons(browser) -> None:
    """Значок приложения: обычный (лаймовое поле целиком — углы скругляет система), тёмный
    (монограмма на прозрачном фоне: тёмную подложку даёт система) и одноцветный для оттенков."""
    # монограмма чуть меньше, чем в знаке: у значка iPhone скругление крупнее и поля шире
    inner = '<g transform="translate(128 128) scale(0.9) translate(-128 -133)">{}</g>'
    light = render(browser, svg(f'<rect width="256" height="256" fill="{LIME}"/>' + inner.format(t_shapes(INK, LIME)), 1024), 1024).convert("RGB")
    dark = render(browser, svg(inner.format(t_shapes(LIME, INK)), 1024), 1024)
    tinted = render(browser, svg('<rect width="256" height="256" fill="#000"/>' + inner.format(t_shapes("#f2f2f2", "#000")), 1024), 1024).convert("L")
    for name in ("AppIcon", "AppIcon_Developer", "AppIcon_Beta"):
        base = f"{CLIENT}AppIcons.xcassets/{name}.appiconset/"
        save(light, base + "appstore.png")
        save(dark, base + "appstore-dark.png")
        save(tinted, base + "appstore-tinted.png")


def glass_icons() -> None:
    """Значок нового образца (Icon Composer): заливка поля и один слой — монограмма."""
    icon = {
        "fill": {"solid": "srgb:0.78431,0.94902,0.35294,1.00000"},
        "groups": [{
            "layers": [{"hidden": False, "image-name": "t.svg", "name": "t"}],
            "shadow": {"kind": "neutral", "opacity": 0.35},
            "translucency": {"enabled": False, "value": 0.5},
        }],
        "supported-platforms": {"circles": ["watchOS"], "squares": "shared"},
    }
    glyph = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
             '<g transform="translate(512 512) scale(3.6) translate(-128 -133)">' + t_shapes(INK, LIME) + "</g></svg>\n")
    for name in ("AppIcon", "AppIcon_Developer", "AppIcon_Beta"):
        base = f"{CLIENT}LiquidGlassAppIcons/{name}.icon/"
        write(base + "icon.json", json.dumps(icon, indent=2) + "\n")
        write(base + "Assets/t.svg", glyph)


def splash(browser) -> None:
    """Заставка запуска: знак по центру на фоне системы (LaunchScreen.xib, картинка splash 134 pt)."""
    mark = svg(f'<rect x="11" y="11" width="234" height="234" rx="53" fill="{LIME}"/>'
               '<g transform="translate(128 128) scale(0.914) translate(-128 -128)">' + t_shapes(INK, LIME) + "</g>", 134)
    for scale, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        save(render(browser, mark, 134, scale), f"{CLIENT}Images.xcassets/splash.imageset/splash{suffix}.png")


# Картинки Firefox в интерфейсе (логотип, лиса): каждая заменяется знаком Tabora в поле того же
# размера, чтобы раскладка экранов не менялась. Пути относительно исходников Firefox для iOS.
IMG = "firefox-ios/Client/Assets/Images.xcassets/"
KIT = "BrowserKit/Sources/OnboardingKit/Media.xcassets/"
MARKS = [
    IMG + "fxHomeHeaderLogoBall.imageset/fxLogo.pdf",
    KIT + "fxHomeHeaderLogoBall.imageset/fxLogo.pdf",
    KIT + "firefoxLoader.imageset/firefoxLoader.pdf",
    IMG + "logoFirefoxLarge.imageset/logoFirefoxLarge.pdf",
    "firefox-ios/Extensions/ShareTo/Images.xcassets/logoFirefoxLarge.imageset/logoFirefoxLarge.pdf",
    IMG + "foxConfirmation.imageset/foxConfirmation.pdf",
    IMG + "foxWithStars.imageset/foxWithStars.pdf",
    IMG + "foxDefaultBrowser.imageset/Illu.png",
    IMG + "noBookmarksInRoot.imageset/noBookmarks.pdf",
    IMG + "noBookmarksInFolder.imageset/MobileBookmarks_folder.pdf",
    IMG + "NativeErrorPage/noInternetConnection.imageset/kit-error-plug.pdf",
    IMG + "NativeErrorPage/securityError.imageset/securityError.pdf",
    IMG + "protectionPanelAlert.imageset/Protection-Panel-Illustration-On.pdf",
    IMG + "protectionPanelOff.imageset/Protection-Panel-Illustration-On.pdf",
    IMG + "protectionPanelOn.imageset/Protection-Panel-Illustration-On.pdf",
    IMG + "homepage-pocket.imageset/homepage-pocket.pdf",
    "BrowserKit/Sources/SiteImageView/BundledTopSitesFavicons.xcassets/firefox-jp.imageset/firefox-jp.png",
    "firefox-ios/Extensions/ShareTo/Images.xcassets/Icon-Small.imageset/icon-40.png",
    "firefox-ios/Extensions/ShareTo/Images.xcassets/Icon-Small.imageset/icon-40@2x.png",
    "firefox-ios/Extensions/ShareTo/Images.xcassets/Icon-Small.imageset/icon-40@3x.png",
    KIT + "onboardingToolbarIconBottomJapan.imageset/onboardingToolbarIconBottomJapan-notselected.pdf",
    KIT + "onboardingToolbarIconBottomJapanSelected.imageset/onboardingToolbarIconBottomJapan-selected.pdf",
    KIT + "onboardingToolbarIconTopJapan.imageset/onboardingToolbarIconTopJapan-notselected.pdf",
    KIT + "onboardingToolbarIconTopJapanSelected.imageset/onboardingToolbarIconTopJapan-selected.pdf",
    IMG + "faviconFox.imageset/back-panel-home.png",
    IMG + "faviconFox.imageset/back-panel-home@2x.png",
    IMG + "faviconFox.imageset/back-panel-home@3x.png",
    IMG + "Onboarding/Headers/onboardingWelcome.imageset/onboardingWelcome.pdf",
    IMG + "Onboarding/Headers/onboardingFoxyWindow.imageset/buildABetterWeb.pdf",
    IMG + "Onboarding/Headers/signin-sync.imageset/signin-sync-glow.pdf",
    IMG + "Onboarding/Headers/onboardingSync.imageset/onboardingSync.pdf",
    IMG + "Onboarding/Headers/onboardingDock.imageset/onboardingDock.pdf",
    IMG + "Onboarding/Headers/onboardingNotification.imageset/onboardingNotifications.pdf",
    IMG + "Onboarding/Headers/onboardingSearchWidget.imageset/onboardingSearchWidget.pdf",
    IMG + "Onboarding/Headers/onboardingSetDefaultSteps.imageset/onboardingSetDefaultSteps.pdf",
    IMG + "Onboarding/ContinuousOnboarding/kitCircle.imageset/kitCircle.pdf",
    IMG + "Onboarding/ContinuousOnboarding/kitOnboardingNotifications.imageset/kitOnboardingNotifications.pdf",
    IMG + "Onboarding/ContinuousOnboarding/kitOnboardingNotifications.imageset/kitOnboardingNotificationsDark.pdf",
    IMG + "Onboarding/ContinuousOnboarding/kitOnboardingSync.imageset/kitOnboardingSync.pdf",
    IMG + "Onboarding/ContinuousOnboarding/kitOnboardingSync.imageset/kitOnboardingSyncDark.pdf",
    KIT + "onboardingSyncWithIcons.imageset/syncWithIcons.pdf",
    KIT + "onboardingSyncWithIconsBrandRefresh.imageset/onboardingSyncWithIconsBrandRefresh.pdf",
    KIT + "onboardingSyncWithIconsJapan.imageset/onboardingSyncWithIconsJapan.pdf",
    KIT + "onboardingTrackers.imageset/trackers.pdf",
    KIT + "onboardingTrackersBrandRefresh.imageset/onboardingTrackersBrandRefresh.pdf",
    KIT + "onboardingTrackersJapan.imageset/onboardingTrackersJapan.pdf",
    KIT + "onboardingWelcomeBrandRefresh.imageset/onboardingWelcomeBrandRefresh.pdf",
    KIT + "onboardingWelcomeJapan.imageset/Firefox_Marco_Icons_x2.pdf",
    "firefox-ios/Client/Assets/kitHeroGif.gif",
    "firefox-ios/Client/Assets/easterEggGif.gif",
]
WORDMARK = IMG + "fxHomeHeaderLogoText.imageset/fxHomeHeaderLogoText.pdf"
# Отметка выбранного варианта (фиолетовая и синяя у Firefox) — лаймовый круг с тёмной галочкой
CHECKS = [
    IMG + "radioButtonSelectedNova.imageset/radioButtonSelectedNova.pdf",
    IMG + "radioButtonSelected.imageset/radioButtonSelected.pdf",
    KIT + "radioButtonSelected.imageset/radioButtonSelected.pdf",
]


def original_size(rel: str) -> tuple[float, float]:
    """Размер исходной картинки: у PDF — в пунктах, у растровых — в пикселях."""
    path = TREE / rel
    if not path.exists():
        sys.exit(f"нет исходной картинки {rel}: tools/ios/build.py fetch")
    if path.suffix == ".pdf":
        out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)], capture_output=True, text=True, check=True).stdout
        values = [float(line.split(":")[1]) for line in out.splitlines() if "pixel" in line]
        return values[0], values[1]
    with Image.open(path) as im:
        return im.size


def mark_in(width: float, height: float) -> str:
    """Знак по центру поля: квадрат со скруглением занимает меньшую сторону целиком."""
    side = min(width, height)
    scale = side / 256
    x, y = (width - side) / 2, (height - side) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">'
            f'<g transform="translate({x} {y}) scale({scale})"><rect width="256" height="256" rx="58" fill="{LIME}"/>{t_shapes(INK, LIME)}</g></svg>')


def pdf(browser, markup: str, width: float, height: float) -> bytes:
    """Векторный PDF точно заданного размера в пунктах (CSS-единица pt совпадает с пунктом PDF)."""
    page = browser.new_page()
    page.set_content(f'<!doctype html><style>@page{{size:{width}pt {height}pt;margin:0}}html,body{{margin:0;background:transparent}}'
                     f'#box{{width:{width}pt;height:{height}pt;overflow:hidden;display:flex;align-items:center}}svg{{display:block;width:{width}pt;height:{height}pt}}</style>'
                     f'<div id="box">{markup}</div>')
    page.evaluate("document.fonts.ready")
    data = page.pdf(width=f"{width / 72}in", height=f"{height / 72}in", print_background=False, page_ranges="1")
    page.close()
    return data


def logos(browser) -> None:
    for rel in MARKS:
        width, height = original_size(rel)
        out = OUT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".pdf"):
            out.write_bytes(pdf(browser, mark_in(width, height), width, height))
        else:
            im = render(browser, mark_in(width, height), max(int(width), int(height)), 1).crop((0, 0, int(width), int(height)))
            if rel.endswith(".gif"):
                # анимация с лисой заменяется неподвижным знаком на белом поле
                flat = Image.new("RGB", im.size, "#ffffff")
                flat.paste(im, mask=im.getchannel("A"))
                flat.save(out, "GIF")
            else:
                im.save(out, "PNG", optimize=True)
        print(f"  {rel}  {width:g}×{height:g}")
    for rel in CHECKS:
        width, height = original_size(rel)
        side = min(width, height)
        check = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{side}" height="{side}">'
                 f'<circle cx="12" cy="12" r="12" fill="{LIME}"/>'
                 f'<path d="M6.8 12.4l3.4 3.4 7-7.2" fill="none" stroke="{INK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>')
        out = OUT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(pdf(browser, check, width, height))
        print(f"  {rel}  {width:g}×{height:g}")
    # надпись в шапке домашней страницы: рисуется как шаблон, цвет даёт тема
    width, height = original_size(WORDMARK)
    font = base64.b64encode(FONT.read_bytes()).decode()
    text = (f'<style>@font-face{{font-family:"Manrope";font-weight:200 800;src:url(data:font/woff2;base64,{font}) format("woff2")}}</style>'
            f'<span style="font:800 {height * 1.02}pt/1 Manrope;letter-spacing:-0.035em;color:#000;white-space:nowrap;display:block;height:{height}pt;line-height:{height}pt">Tabora</span>')
    out = OUT / WORDMARK
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf(browser, text, width, height))
    print(f"  {WORDMARK}  {width:g}×{height:g}")


def main() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        print("значок приложения")
        app_icons(browser)
        glass_icons()
        print("заставка")
        splash(browser)
        print("логотипы в интерфейсе")
        logos(browser)
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
