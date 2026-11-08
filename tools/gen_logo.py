#!/usr/bin/env python3
"""Генерация логотипа через OpenAI Images и нарезка иконок для брендинга.

  tools/gen_logo.py generate [--n 3] [--prompt FILE]   создать варианты в .build/logo/
  tools/gen_logo.py apply <png>                         нарезать выбранный PNG в configs/branding/<brand>/

Ключ берётся из переменной OPENAI_API_KEY или из файла .env в корне проекта.
Для нарезки нужна Pillow: python3 -m venv .build/venv && .build/venv/bin/pip install pillow
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".build" / "logo"
PNG_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512, 1024]

DEFAULT_PROMPT = (
    "Minimal flat app icon for a modern web browser with a built-in AI agent. "
    "A single glowing lime-green sphere (#C8F25A) with a small dark core, centered on a near-black "
    "rounded square background (#121317) with a subtle thin lighter border (#2A2D34). "
    "Clean geometric shapes, no text, no letters, no gradients except a soft inner glow on the sphere, "
    "no shadows outside the square, crisp edges, vector style, centered composition, "
    "designed to read clearly at 16 pixels. Square format."
)


def api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("OPENAI_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"')
    if not key:
        sys.exit("нет OPENAI_API_KEY: задайте переменную окружения или строку в .env")
    return key


def generate(args: argparse.Namespace) -> None:
    prompt = Path(args.prompt).read_text().strip() if args.prompt else DEFAULT_PROMPT
    OUT.mkdir(parents=True, exist_ok=True)
    body = json.dumps({
        "model": args.model,
        "prompt": prompt,
        "n": args.n,
        "size": "1024x1024",
        "quality": args.quality,
        "background": "opaque",
        "output_format": "png",
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=body,
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
    )
    print(f"генерирую {args.n} вариант(а) моделью {args.model}…", flush=True)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ошибка API {e.code}: {e.read().decode()[:500]}")
    existing = len(list(OUT.glob("variant-*.png")))
    for i, item in enumerate(data["data"], start=existing + 1):
        path = OUT / f"variant-{i}.png"
        path.write_bytes(base64.b64decode(item["b64_json"]))
        print(f"→ {path.relative_to(ROOT)}")
    (OUT / "prompt.txt").write_text(prompt + "\n")


def apply(args: argparse.Namespace) -> None:
    try:
        from PIL import Image
    except ImportError:
        sys.exit("нужна Pillow: .build/venv/bin/pip install pillow и запуск через .build/venv/bin/python")
    config = json.loads((ROOT / "browser.json").read_text())
    brand = args.brand or config.get("brand", "release")
    dest = ROOT / "configs" / "branding" / brand
    dest.mkdir(parents=True, exist_ok=True)
    src = Image.open(args.png).convert("RGBA")
    if src.width != src.height:
        side = min(src.size)
        left, top = (src.width - side) // 2, (src.height - side) // 2
        src = src.crop((left, top, left + side, top + side))
    base = src.resize((1024, 1024), Image.LANCZOS)
    base.save(dest / "logo.png")
    for size in PNG_SIZES:
        base.resize((size, size), Image.LANCZOS).save(dest / f"logo{size}.png")
    # macOS: по рекомендациям Apple сама форма занимает около 80% холста
    mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    inner = base.resize((824, 824), Image.LANCZOS)
    mac.paste(inner, (100, 100), inner)
    mac.save(dest / "logo-mac.png")
    mac.save(dest / "firefox.icns", format="ICNS", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    base.save(dest / "firefox.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    base.resize((64, 64), Image.LANCZOS).save(dest / "firefox64.ico", format="ICO", sizes=[(64, 64)])
    # SVG для диалога «О программе»: растровый логотип, встроенный в SVG
    png_b64 = base64.b64encode((dest / "logo512.png").read_bytes()).decode()
    (dest / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'width="512" height="512" viewBox="0 0 512 512">'
        f'<image width="512" height="512" xlink:href="data:image/png;base64,{png_b64}"/></svg>\n'
    )
    print(f"иконки записаны в {dest.relative_to(ROOT)}: png ×{len(PNG_SIZES)}, logo-mac.png, icns, ico, svg")


def main() -> None:
    parser = argparse.ArgumentParser(prog="tools/gen_logo.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--brand")
    sub = parser.add_subparsers(dest="command", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--n", type=int, default=3)
    g.add_argument("--prompt", help="файл с текстом запроса")
    g.add_argument("--model", default="gpt-image-2")
    g.add_argument("--quality", default="high", choices=["low", "medium", "high", "auto"])
    g.set_defaults(fn=generate)
    a = sub.add_parser("apply")
    a.add_argument("png")
    a.set_defaults(fn=apply)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
