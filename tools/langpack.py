#!/usr/bin/env python3
"""Языковой пакет Firefox с брендом Tabora (вспомогательный инструмент).

Сборка его больше не использует: перевод встраивается в приложение multi-locale
упаковкой (tools/build.py package → mach package-multi-locale), а подпись дополнений
обязательна, поэтому пакет с изменённым брендингом (подпись Mozilla снята) релизная
сборка не загрузит. Инструмент оставлен для сравнения строк и проверок в сборках
разработчика.

Официальный пакет скачивается с archive.mozilla.org и сверяется с SHA512SUMS
(подпись Mozilla проверяется, если установлен gpg).

  tools/langpack.py [--locale ru] [--version 159.0.1] [--out .build/langpacks]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build as buildtool  # noqa: E402

BUILD_STATE = ROOT / ".build"
CACHE = BUILD_STATE / "langpacks"

XPI_URL = "https://archive.mozilla.org/pub/firefox/releases/{v}/mac/xpi/{locale}.xpi"
LANGPACK_ID = "langpack-{locale}@firefox.mozilla.org"

# Файлы брендинга внутри пакета → наш файл из брендинга сборки
BRANDING_FILES = {
    "browser/localization/{locale}/branding/brand.ftl": "locales/en-US/brand.ftl",
    "browser/chrome/{locale}/locale/branding/brand.properties": "locales/en-US/brand.properties",
}

NAMES = {"ru": "Русский язык интерфейса Tabora"}


def engine_version() -> str:
    path = BUILD_STATE / "engine-version"
    if not path.exists():
        sys.exit("нет .build/engine-version: сначала tools/build.py download")
    return path.read_text().strip()


def download(locale: str, version: str) -> Path:
    if not buildtool.FIREFOX_VERSION_RE.match(version):
        sys.exit(f"неверная версия Firefox: {version!r}")
    if not re.match(r"^[a-z]{2,3}(-[A-Z]{2}|-[a-zA-Z]{4,8})?$", locale):
        sys.exit(f"неверный код языка: {locale!r}")
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"{locale}-{version}.orig.xpi"
    expected = buildtool.mozilla_sha512(version, f"mac/xpi/{locale}.xpi")
    if dest.exists() and buildtool.sha512_file(dest) == expected:
        return dest
    url = XPI_URL.format(v=version, locale=locale)
    print(f"скачиваю {url}")
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as out:
        if not resp.geturl().startswith("https://archive.mozilla.org/"):
            sys.exit(f"перенаправление на чужой адрес: {resp.geturl()}")
        shutil.copyfileobj(resp, out)
    if buildtool.sha512_file(tmp) != expected:
        tmp.unlink()
        sys.exit(f"хеш {url} не совпадает с SHA512SUMS: файл удалён")
    tmp.rename(dest)
    return dest


def build_langpack(locale: str, version: str, branding_dir: Path, out_dir: Path) -> Path:
    """Собирает <out_dir>/langpack-<locale>@firefox.mozilla.org.xpi с брендом Tabora."""
    orig = download(locale, version)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / (LANGPACK_ID.format(locale=locale) + ".xpi")
    replaced = 0
    with zipfile.ZipFile(orig) as src, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            name = item.filename
            if name.startswith("META-INF/"):
                continue  # подпись Mozilla больше не действительна
            data = src.read(name)
            if name == "manifest.json":
                manifest = json.loads(data)
                manifest["name"] = NAMES.get(locale, manifest.get("name", locale))
                manifest["description"] = "Перевод интерфейса Tabora на основе локализации Firefox."
                manifest.pop("author", None)
                data = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
            for pattern, ours in BRANDING_FILES.items():
                if name == pattern.format(locale=locale):
                    data = (branding_dir / ours).read_bytes()
                    replaced += 1
            dst.writestr(item, data)
    if replaced != len(BRANDING_FILES):
        print(f"внимание: заменено файлов брендинга {replaced} из {len(BRANDING_FILES)}", file=sys.stderr)
    return dest


def install_into(app_resources: Path, xpi: Path) -> Path:
    """Кладёт пакет во встроенные расширения приложения."""
    ext_dir = app_resources / "distribution" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    target = ext_dir / xpi.name
    shutil.copy(xpi, target)
    return target


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--locale", default="ru")
    ap.add_argument("--version", default=None, help="версия Firefox (по умолчанию из .build/engine-version)")
    ap.add_argument("--branding", default=str(ROOT / "engine/browser/branding/release"))
    ap.add_argument("--out", default=str(CACHE))
    ap.add_argument("--app", help="Contents/Resources приложения, куда сразу положить пакет")
    args = ap.parse_args()
    xpi = build_langpack(args.locale, args.version or engine_version(), Path(args.branding), Path(args.out))
    print("пакет:", xpi.relative_to(ROOT) if xpi.is_relative_to(ROOT) else xpi)
    if args.app:
        print("установлен:", install_into(Path(args.app), xpi))


if __name__ == "__main__":
    main()
