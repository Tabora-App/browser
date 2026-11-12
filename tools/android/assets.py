#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Картинки Tabora для приложения Android вместо логотипов Firefox.

Рисует знак (лаймовый квадрат с монограммой T) и надпись «Tabora» шрифтом Manrope и кладёт
результат в src/mobile/android/fenix/app/src/…: оттуда tools/build.py import подключает файлы
в дерево движка поверх картинок Firefox. Запускать нужно только при смене знака; готовые файлы
лежат в репозитории.

Нужны: Python с Pillow (с поддержкой WebP) и Playwright с Chromium.

    python3 tools/android/assets.py
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent.parent
ANDROID = ROOT / "src" / "mobile" / "android"
APP = ANDROID / "fenix" / "app" / "src"
AC = "android-components/components/"
FENIX_RES = "fenix/app/src/main/res/"

# Картинки Firefox в интерфейсе (лиса и логотип): каждая заменяется знаком Tabora того же размера,
# чтобы раскладка экранов не менялась. Путь относительно mobile/android, размер в dp.
MASCOTS = [
    (AC + "lib/llm-mlpa/src/main/res/drawable/firefox_icon.xml", 16, 16),
    (AC + "ui/icons/src/main/res/drawable/mozac_ic_logo_firefox_24.xml", 24, 24),
    (FENIX_RES + "drawable-nodpi/firefox_as_default_banner_illustration.xml", 78, 53),
    (FENIX_RES + "drawable/expressive_firefox.xml", 35, 31),
    (FENIX_RES + "drawable/fox_ai_on_state.xml", 62, 63),
    (FENIX_RES + "drawable/fox_exclamation_alert.xml", 200, 200),
    (FENIX_RES + "drawable/ic_firefox.xml", 108, 112),
    (FENIX_RES + "drawable/ic_kit_bookmarks_empty_state.xml", 200, 178),
    (FENIX_RES + "drawable/ic_kit_heart.xml", 141, 150),
    (FENIX_RES + "drawable/ic_kit_plug_error.xml", 200, 150),
    (FENIX_RES + "drawable/ic_kit_shield_off_state.xml", 58, 60),
    (FENIX_RES + "drawable/ic_kit_shield_on_state.xml", 58, 60),
    (FENIX_RES + "drawable/illustration_fox_box_inside_light.xml", 176, 160),
    (FENIX_RES + "drawable/kit_devices_sync_error.xml", 242, 90),
    (FENIX_RES + "drawable/kit_devices_sync.xml", 210, 90),
    (FENIX_RES + "drawable/kit_expressive_full.xml", 66, 62),
    (FENIX_RES + "drawable/kit_head_protection_blocker_banner.xml", 78, 78),
    (FENIX_RES + "drawable/kit_plug_error.xml", 137, 103),
    (FENIX_RES + "drawable/kit_search_error.xml", 120, 139),
    (FENIX_RES + "drawable/mozac_ic_kit_tab_groups_list_view.xml", 78, 68),
    (FENIX_RES + "drawable/mozac_ic_kit_tab_groups.xml", 144, 80),
]
FONT = ROOT / "src" / "browser" / "base" / "content" / "tabora" / "fonts" / "Manrope-latin.woff2"

LIME = "#c8f25a"
SLEEPING_SIZE = (180, 103)  # размер исходной картинки kit_sleeping_under_laptop.webp
INK = "#0b0c0e"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

# Знак в поле 256×256 — те же числа, что в web/static/icons/mark.svg
T_SHAPES = f"""<rect x="56" y="66" width="144" height="38" rx="19" fill="{INK}"/>
<rect x="109" y="66" width="38" height="134" rx="19" fill="{INK}"/>
<circle cx="181" cy="85" r="11" fill="{LIME}"/>"""


def mark_svg(size: float, shape: str = "square") -> str:
    back = (f'<circle cx="128" cy="128" r="128" fill="{LIME}"/>' if shape == "round"
            else f'<rect width="256" height="256" rx="58" fill="{LIME}"/>')
    # в круге монограмма меньше, чтобы не упираться в край
    inner = f'<g transform="translate(128 128) scale(0.82) translate(-128 -133)">{T_SHAPES}</g>' if shape == "round" else T_SHAPES
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="{size}" height="{size}" '
            f'style="display:block;flex:none">{back}{inner}</svg>')


def page_html(body: str) -> str:
    font = base64.b64encode(FONT.read_bytes()).decode()
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: "Manrope"; font-weight: 200 800; src: url(data:font/woff2;base64,{font}) format("woff2"); }}
html, body {{ margin: 0; background: transparent; }}
#shot {{ display: inline-flex; align-items: center; font-family: "Manrope"; font-weight: 800; letter-spacing: -0.035em; line-height: 1; white-space: nowrap; }}
</style><div id="shot">{body}</div>"""


def render(browser, body: str, scale: float = 1) -> Image.Image:
    ctx = browser.new_context(device_scale_factor=scale, viewport={"width": 1400, "height": 500})
    page = ctx.new_page()
    page.set_content(page_html(body))
    page.evaluate("document.fonts.ready")
    png = page.locator("#shot").screenshot(omit_background=True)
    ctx.close()
    return Image.open(io.BytesIO(png)).convert("RGBA")


def tight(im: Image.Image) -> Image.Image:
    return im.crop(im.getchannel("A").getbbox())


def save(im: Image.Image, rel: str) -> None:
    out = APP / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "WEBP", lossless=True, method=6)
    print(f"  {rel}  {im.width}×{im.height}")


LICENSE = """<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->"""


def n(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


def pill(x: float, y: float, w: float, h: float, r: float) -> str:
    """Прямоугольник со скруглёнными углами; прямые участки нулевой длины не пишутся."""
    def line(cmd: str, length: float) -> str:
        return f"{cmd}{n(length)}" if abs(length) > 0.0005 else ""
    arc = f"a{n(r)},{n(r)} 0 0 1 "
    return (f"M{n(x + r)},{n(y)}{line('h', w - 2 * r)}{arc}{n(r)},{n(r)}{line('v', h - 2 * r)}"
            f"{arc}-{n(r)},{n(r)}{line('h', -(w - 2 * r))}{arc}-{n(r)},-{n(r)}"
            f"{line('v', -(h - 2 * r))}{arc}{n(r)},-{n(r)}z")


def disc(cx: float, cy: float, r: float) -> str:
    return f"M{n(cx - r)},{n(cy)}a{n(r)},{n(r)} 0 1 0 {n(2 * r)},0a{n(r)},{n(r)} 0 1 0 -{n(2 * r)},0z"


def t_paths(cx: float, cy: float, width: float):
    """Монограмма T шириной width с центром в (cx, cy): перекладина, ножка и точка."""
    k = width / 144
    x = lambda v: cx + (v - 128) * k
    y = lambda v: cy + (v - 133) * k
    r = 19 * k
    return (pill(x(56), y(66), 144 * k, 38 * k, r), pill(x(109), y(66), 38 * k, 134 * k, r), disc(x(181), y(85), 11 * k))


def vector(size: int, viewport: int, body: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
{LICENSE}
<!-- Знак Tabora. Файл создан tools/android/assets.py -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{size}dp"
    android:height="{size}dp"
    android:viewportWidth="{viewport}"
    android:viewportHeight="{viewport}">
{body}</vector>
"""


def path(data: str, color: str, even_odd: bool = False) -> str:
    rule = '\n      android:fillType="evenOdd"' if even_odd else ""
    return f'  <path\n      android:fillColor="{color}"{rule}\n      android:pathData="{data}"/>\n'


def write(rel: str, text: str, base: Path = APP) -> None:
    out = base / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"  {rel}")


def mark_vector(w: float, h: float) -> str:
    """Знак Tabora в поле w×h dp: в значках до 24 dp занимает всё поле, в картинках — 64 %."""
    side = min(w, h) * (1.0 if min(w, h) <= 24 else 0.64)
    left, top = (w - side) / 2, (h - side) / 2
    bar, stem, dot = t_paths(left + side / 2, top + side * 133 / 256, side * 144 / 256)
    ink, lime = INK.upper(), LIME.upper()
    body = path(pill(left, top, side, side, side * 58 / 256), lime) + path(bar, ink) + path(stem, ink) + path(dot, lime)
    return f"""<?xml version="1.0" encoding="utf-8"?>
{LICENSE}
<!-- Знак Tabora на месте картинки Firefox. Файл создан tools/android/assets.py -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{n(w)}dp"
    android:height="{n(h)}dp"
    android:viewportWidth="{n(w)}"
    android:viewportHeight="{n(h)}">
{body}</vector>
"""


def mascots() -> None:
    for rel, w, h in MASCOTS:
        write(rel, mark_vector(w, h), ANDROID)
    # Анимация с лисой (подсказка о группах вкладок): пустая композиция того же размера
    write(FENIX_RES + "raw/mozac_ic_kit_tab_groups_animation.json",
          '{"v":"5.7.4","fr":30,"ip":0,"op":30,"w":144,"h":80,"nm":"tabora","ddd":0,"assets":[],"layers":[]}\n', ANDROID)


def vectors() -> None:
    ink, lime = INK.upper(), LIME.upper()
    # Значок запуска: фон (лаймовый) задаёт цвет ic_launcher_background, здесь только монограмма.
    # Оболочка телефона обрезает значок своей маской, поэтому монограмма держится в середине.
    bar, stem, dot = t_paths(54, 54, 42)
    write("release/res/drawable/ic_launcher_foreground.xml", vector(108, 108, path(bar, ink) + path(stem, ink) + path(dot, lime)))
    # Одноцветный значок (оформление «в цвет обоев»): точка — просвет в перекладине
    write("main/res/drawable/ic_launcher_monochrome.xml",
          vector(108, 108, path(bar + dot, "#FFFFFF", True) + path(stem, "#FFFFFF")))
    # Заставка при запуске: знак целиком, в пределах круга, которым система обрезает картинку
    bar, stem, dot = t_paths(54, 54.98, 28.12)
    write("main/res/drawable/ic_splash_logo.xml",
          vector(108, 108, path(pill(29, 29, 50, 50, 11.33), lime) + path(bar, ink) + path(stem, ink) + path(dot, lime)))
    # Знак в строке уведомлений: система рисует его одним цветом
    bar, stem, dot = t_paths(12, 12, 18)
    write("main/res/drawable/ic_status_logo.xml",
          vector(24, 24, path(bar + dot, "@android:color/white", True) + path(stem, "@android:color/white")))
    write("release/res/values/colors.xml", f"""<?xml version="1.0" encoding="utf-8"?>
{LICENSE}
<resources>
    <color name="ic_launcher_background">{lime}</color>
</resources>
""")


def main() -> None:
    if not FONT.is_file():
        sys.exit(f"нет шрифта {FONT}")
    vectors()
    mascots()
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # Значок запуска для старых оболочек (новые берут векторный значок из mipmap-anydpi)
        for name, k in DENSITIES.items():
            size = round(48 * k)
            for shape, file in (("square", "ic_launcher"), ("round", "ic_launcher_round")):
                im = render(browser, mark_svg(48, shape), k).resize((size, size), Image.LANCZOS)
                save(im, f"release/res/mipmap-{name}/{file}.webp")

        # Знак с надписью (экран «О приложении»): обычный вид — тёмная надпись, приватный — белая
        for name, k in DENSITIES.items():
            for kind, color in (("normal", "#15141a"), ("private", "#ffffff")):
                body = f'{mark_svg(80)}<span style="margin-left:20px;font-size:62px;color:{color}">Tabora</span>'
                save(render(browser, body, k), f"release/res/drawable-{name}/ic_logo_wordmark_{kind}.webp")

        # Стартовая страница: знак и надпись — отдельные картинки (надпись приложение перекрашивает само)
        save(render(browser, mark_svg(160)), "release/res/drawable-nodpi/ic_wordmark_logo.webp")
        for kind, color in (("normal", "#15141a"), ("private", "#ffffff")):
            text = tight(render(browser, f'<span style="font-size:120px;color:{color};padding:20px">Tabora</span>'))
            save(text.resize((round(text.width * 93 / text.height), 93), Image.LANCZOS),
                 f"release/res/drawable-nodpi/ic_wordmark_text_{kind}.webp")

        # Образец виджета поиска в списке виджетов телефона: без слов, чтобы не зависеть от языка
        widget = f"""<div style="width:676px;height:120px;display:flex;align-items:center;justify-content:center">
<div style="width:656px;height:100px;border-radius:26px;background:#f9f9fb;display:flex;align-items:center;box-sizing:border-box;padding:0 30px;box-shadow:0 1px 3px rgba(0,0,0,.18)">
{mark_svg(52)}
<div style="margin-left:24px;width:230px;height:14px;border-radius:7px;background:#d9dae0"></div>
<svg style="margin-left:auto" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#15141a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
</div></div>"""
        save(render(browser, widget, 1.5), "release/res/drawable-hdpi/fenix_search_widget.webp")

        # Растровая картинка с лисой (пустой экран): знак Tabora на прозрачном поле того же размера
        sleeping = Image.new("RGBA", SLEEPING_SIZE, (0, 0, 0, 0))
        side = round(min(SLEEPING_SIZE) * 0.64)
        logo = render(browser, mark_svg(side))
        sleeping.paste(logo, ((SLEEPING_SIZE[0] - side) // 2, (SLEEPING_SIZE[1] - side) // 2), logo)
        save(sleeping, "main/res/drawable-nodpi/kit_sleeping_under_laptop.webp")
        browser.close()


if __name__ == "__main__":
    main()
