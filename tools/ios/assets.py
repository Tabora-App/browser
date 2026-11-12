#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Картинки Tabora для приложения iPhone вместо логотипов Firefox.

Рисует знак (лаймовый квадрат с монограммой T — те же числа, что в web/static/icons/mark.svg)
и кладёт результат в src/ios/…: оттуда tools/ios/build.py import подключает файлы поверх картинок
Firefox для iOS. Запускать нужно только при смене знака; готовые файлы лежат в репозитории.

Нужны: Python с Pillow и Playwright с Chromium.

    python3 tools/ios/assets.py
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "src" / "ios"
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


def main() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        print("значок приложения")
        app_icons(browser)
        glass_icons()
        print("заставка")
        splash(browser)
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
