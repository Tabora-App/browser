#!/usr/bin/env python3
"""Инструмент сборки браузера на базе Firefox.

Исходники Firefox не хранятся в репозитории: инструмент скачивает нужную версию
в engine/, накладывает поверх неё брендинг из configs/branding/<brand> и наши
изменения из src/, пишет mozconfig и вызывает штатный mach от Mozilla.

Команды:
  download        скачать исходники Firefox версии из browser.json в engine/
  import          наложить брендинг и изменения из src/ на engine/
  export          превратить правки, сделанные прямо в engine/, в патчи в src/
  reset           вернуть engine/ к чистому Firefox
  bootstrap       поставить тулчейны Mozilla (mach bootstrap)
  build [--ui]    полная сборка; --ui пересобирает только интерфейс
  run [-- args]   запустить собранный браузер
  l10n            скачать переводы (firefox-l10n) для locales из browser.json
  package         упаковать сборку в dist/ (с переводами: mach package-multi-locale)
  update [--to V] обновить версию Firefox в browser.json (по умолчанию до последней)
  status          показать версию, бренд и платформу

Переменные окружения:
  TARGET_PLATFORM  darwin | linux (по умолчанию хост)
  TARGET_ARCH      aarch64 | x86_64 (по умолчанию хост)
  BROWSER_RELEASE  1 = релизная сборка (оптимизации, без тестов)
  BROWSER_DISABLE_LTO, BROWSER_DISABLE_BOOTSTRAP  см. configs/common/mozconfig
  TABORA_SAFEBROWSING_KEYFILE  файл ключа Google Safe Browsing (по умолчанию
                   ~/.config/tabora/safebrowsing.key, если он есть)

Только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "engine"
SRC = ROOT / "src"
CONFIGS = ROOT / "configs"
BUILD_STATE = ROOT / ".build"
DIST = ROOT / "dist"
CONFIG_FILE = ROOT / "browser.json"

RELEASES = "https://archive.mozilla.org/pub/firefox/releases/{v}/"
ARCHIVE = RELEASES + "source/firefox-{v}.source.tar.xz"
PRODUCT_DETAILS = "https://product-details.mozilla.org/1.0/firefox_versions.json"
ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256]

# Версии: Firefox из browser.json / product-details и Tabora (displayVersion)
FIREFOX_VERSION_RE = re.compile(r"^[1-9][0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$")
TABORA_VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$")

# Основной ключ «Mozilla Software Releases <release@mozilla.com>», которым подписаны
# SHA512SUMS на archive.mozilla.org (подключи меняются, основной ключ — нет).
MOZILLA_RELEASE_KEY = "14F26682D0916CDD81E37B6D61B7B526D98F0353"

# Сертификаты подписи MAR, которые зашиваются в обновлятор. Отпечатки закреплены здесь,
# чтобы подмена файлов в src/ (например, через PR) остановила сборку и выпуск.
MAR_CERTS_DIR = SRC / "toolkit" / "mozapps" / "update" / "updater"
MAR_CERT_SHA256 = {
    "release_primary.der": "fb1be9c3c18220af22bde97473907938688c1230f0609fae6392064f78dfa57d",
    "release_secondary.der": "45c17b7466aca5233e88d76ff59acbd3759fe5f627c67110d32cc1cc6b42ceed",
}
MAR_CHANNEL_ID = "tabora-release"

# Переводы интерфейса: монорепозиторий Mozilla, ревизия из browser/locales/l10n-changesets.json
L10N_REPO = "https://github.com/mozilla-l10n/firefox-l10n.git"
L10N_BASE = BUILD_STATE / "l10n-central"
LOCALE_RE = re.compile(r"^[a-z]{2,3}(-[A-Z]{2}|-[a-zA-Z]{4,8})?$")
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


# ---------------------------------------------------------------------------
# Вспомогательное

def log(msg: str) -> None:
    print(f"\033[1;32m›\033[0m {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"\033[1;33m!\033[0m {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"\033[1;31m✗\033[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def run(cmd: List[str], cwd: Path = ROOT, env: Optional[Dict[str, str]] = None, check: bool = True,
        capture: bool = False) -> subprocess.CompletedProcess:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(cmd, cwd=str(cwd), env=full_env, check=check,
                          text=True, capture_output=capture)


def git(args: List[str], cwd: Path = ENGINE, check: bool = True, capture: bool = True) -> str:
    result = run(["git", *args], cwd=cwd, check=check, capture=capture)
    return (result.stdout or "").strip()


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        die(f"нет {CONFIG_FILE.name}")
    return json.loads(CONFIG_FILE.read_text())


def save_config(config: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")


def host_platform() -> str:
    return {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(platform.system(), "linux")


def host_arch() -> str:
    machine = platform.machine().lower()
    return "aarch64" if machine in ("arm64", "aarch64") else "x86_64"


def target_platform() -> str:
    return os.environ.get("TARGET_PLATFORM") or host_platform()


def target_arch() -> str:
    return os.environ.get("TARGET_ARCH") or host_arch()


def target_triple() -> str:
    plat = target_platform()
    arch = target_arch()
    if plat == "darwin":
        return f"{arch}-apple-darwin"
    if plat == "linux":
        return "aarch64-linux-gnu" if arch == "aarch64" else "x86_64-pc-linux"
    die("Windows пока не поддерживается этим инструментом")
    return ""


def objdir() -> Path:
    return ENGINE / f"obj-{target_platform()}-{target_arch()}"


def brand_name(config: dict, override: Optional[str]) -> str:
    name = override or os.environ.get("BROWSER_BRAND") or config.get("brand", "release")
    if name not in config["brands"]:
        die(f"бренд «{name}» не описан в browser.json")
    return name


def need_engine() -> None:
    if not (ENGINE / "mach").exists():
        die("нет исходников Firefox, сначала: tools/build.py download")


def mach_env(config: dict, brand: str) -> Dict[str, str]:
    env = {
        "MOZCONFIG": str(ENGINE / "mozconfig"),
        "TARGET_PLATFORM": target_platform(),
        "TARGET_ARCH": target_arch(),
        "MOZ_NOSPAM": "1",
    }
    if target_platform() != host_platform():
        env["BROWSER_CROSS_COMPILING"] = "1"
    return env


def mach(args: List[str], config: dict, brand: str) -> None:
    need_engine()
    write_mozconfig(config, brand)
    run(["./mach", *args], cwd=ENGINE, env=mach_env(config, brand))


# ---------------------------------------------------------------------------
# download / reset / update

def firefox_version(config: dict) -> str:
    version = config["firefox"]["version"]
    if not isinstance(version, str) or not FIREFOX_VERSION_RE.match(version):
        die(f"неверная версия Firefox в browser.json: {version!r}")
    return version


def _fetch(url: str, limit: int = 8 << 20) -> bytes:
    if not url.startswith("https://"):
        die(f"не https: {url}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        if not resp.geturl().startswith("https://archive.mozilla.org/"):
            die(f"перенаправление на чужой адрес: {resp.geturl()}")
        data = resp.read(limit + 1)
    if len(data) > limit:
        die(f"слишком большой ответ: {url}")
    return data


def _gpg_verify(sums: bytes, sig: bytes, key: bytes) -> Optional[bool]:
    """Подпись SHA512SUMS ключом Mozilla. None — gpg не установлен."""
    gpg = shutil.which("gpg")
    if not gpg:
        return None
    with tempfile.TemporaryDirectory() as home:
        os.chmod(home, 0o700)
        sums_path, sig_path = Path(home) / "SHA512SUMS", Path(home) / "SHA512SUMS.asc"
        sums_path.write_bytes(sums)
        sig_path.write_bytes(sig)
        subprocess.run([gpg, "--batch", "--quiet", "--homedir", home, "--import"], input=key,
                       capture_output=True, check=False)
        res = subprocess.run([gpg, "--batch", "--homedir", home, "--status-fd", "1", "--verify",
                              str(sig_path), str(sums_path)], capture_output=True, check=False)
        for line in res.stdout.decode("utf-8", "replace").splitlines():
            parts = line.split()
            # VALIDSIG <отпечаток подключа> … <отпечаток основного ключа>
            if len(parts) >= 3 and parts[:2] == ["[GNUPG:]", "VALIDSIG"] and parts[-1] == MOZILLA_RELEASE_KEY:
                return True
    return False


def mozilla_sha512(version: str, rel_path: str) -> str:
    """sha512 файла релиза Firefox из SHA512SUMS archive.mozilla.org (с проверкой подписи
    Mozilla, если есть gpg)."""
    base = RELEASES.format(v=version)
    sums = _fetch(base + "SHA512SUMS")
    verified = _gpg_verify(sums, _fetch(base + "SHA512SUMS.asc"), _fetch(base + "KEY"))
    if verified is False:
        die("подпись SHA512SUMS не проверена ключом Mozilla " + MOZILLA_RELEASE_KEY)
    if verified is None:
        warn("gpg не установлен: SHA512SUMS проверен только по https (закрепите хеш в browser.json)")
    for line in sums.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == rel_path and re.match(r"^[0-9a-f]{128}$", parts[0]):
            return parts[0]
    die(f"в SHA512SUMS нет {rel_path}")
    return ""


def sha512_file(path: Path) -> str:
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_source_archive(config: dict) -> Path:
    """Архив исходников Firefox в .build/, проверенный по хешу из browser.json
    (firefox.sha512) или, если хеш не закреплён, по подписанному SHA512SUMS."""
    version = firefox_version(config)
    BUILD_STATE.mkdir(exist_ok=True)
    archive = BUILD_STATE / f"firefox-{version}.source.tar.xz"
    pinned = config["firefox"].get("sha512")
    if pinned is not None and not re.match(r"^[0-9a-f]{128}$", str(pinned)):
        die("firefox.sha512 в browser.json должен быть sha512 в hex")
    expected = pinned or mozilla_sha512(version, f"source/firefox-{version}.source.tar.xz")
    if archive.exists() and sha512_file(archive) != expected:
        warn(f"{archive.name} не совпадает с ожидаемым хешем: перекачиваю")
        archive.unlink()
    if not archive.exists():
        url = ARCHIVE.format(v=version)
        log(f"скачиваю {url}")
        _download(url, archive, expected)
    else:
        log(f"архив уже скачан и проверен: {archive.name}")
    if not pinned:
        config["firefox"]["sha512"] = expected
        save_config(config)
        warn("хеш исходников записан в browser.json (firefox.sha512): закоммитьте его")
    return archive


def cmd_download(args: argparse.Namespace) -> None:
    config = load_config()
    version = firefox_version(config)
    if (ENGINE / "mach").exists() and not args.force:
        current = (BUILD_STATE / "engine-version").read_text().strip() if (BUILD_STATE / "engine-version").exists() else "?"
        if current == version:
            log(f"исходники Firefox {version} уже на месте")
            fetch_l10n(config)
            return
        warn(f"в engine/ лежит Firefox {current}, нужна {version}: перекачиваю")
    archive = fetch_source_archive(config)
    if ENGINE.exists():
        shutil.rmtree(ENGINE)
    log("распаковываю (несколько минут)")
    with tempfile.TemporaryDirectory(dir=str(ROOT)) as tmp:
        tar = shutil.which("gtar") or "tar"
        run([tar, "-xf", str(archive), "-C", tmp, "--no-same-owner"])
        extracted = list(Path(tmp).iterdir())
        if len(extracted) != 1 or extracted[0].name != f"firefox-{version}" or extracted[0].is_symlink():
            die("неожиданное содержимое архива исходников")
        shutil.move(str(extracted[0]), str(ENGINE))
    log("инициализирую git в engine/, чтобы отслеживать наши изменения")
    git(["init", "-q"])
    git(["config", "user.name", "build"])
    git(["config", "user.email", "build@localhost"])
    git(["config", "core.autocrlf", "false"])
    git(["add", "-A"])
    git(["commit", "-qm", f"Firefox {version}"])
    (BUILD_STATE / "engine-version").write_text(version + "\n")
    applied = BUILD_STATE / "applied.json"
    if applied.exists():
        applied.unlink()
    log(f"готово: Firefox {version} в engine/")
    fetch_l10n(config)


def _download(url: str, dest: Path, expected_sha512: str) -> None:
    tmp = dest.with_suffix(".part")
    h = hashlib.sha512()
    with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as out:
        if not resp.geturl().startswith("https://archive.mozilla.org/"):
            die(f"перенаправление на чужой адрес: {resp.geturl()}")
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            h.update(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} МБ", end="", flush=True)
    print()
    if h.hexdigest() != expected_sha512:
        tmp.unlink()
        die(f"хеш {url} не совпадает с ожидаемым: файл удалён")
    tmp.rename(dest)


def fetch_l10n(config: dict) -> None:
    """Переводы для locales из browser.json: ревизия firefox-l10n из l10n-changesets.json
    движка (он сам проверен хешем архива), частичная выборка только нужных языков."""
    locales = [loc for loc in config.get("locales", []) if loc != "en-US"]
    if not locales:
        return
    for loc in locales:
        if not LOCALE_RE.match(loc):
            die(f"неверный код языка: {loc!r}")
    changesets = json.loads((ENGINE / "browser" / "locales" / "l10n-changesets.json").read_text())
    revs = set()
    for loc in locales:
        rev = changesets.get(loc, {}).get("revision", "")
        if not re.match(r"^[0-9a-f]{40}$", rev):
            die(f"нет ревизии перевода {loc} в l10n-changesets.json")
        revs.add(rev)
    if len(revs) != 1:
        die("у языков разные ревизии firefox-l10n: такая выборка не поддерживается")
    rev = revs.pop()
    stamp = L10N_BASE / ".tabora-l10n"
    want = f"{rev} {' '.join(sorted(locales))}\n"
    if stamp.exists() and stamp.read_text() == want and all((L10N_BASE / loc).is_dir() for loc in locales):
        return
    log(f"переводы {', '.join(locales)}: firefox-l10n {rev[:12]}")
    if L10N_BASE.exists():
        shutil.rmtree(L10N_BASE)
    L10N_BASE.mkdir(parents=True)
    g = ["git", "-C", str(L10N_BASE)]
    run([*g, "init", "-q"])
    run([*g, "remote", "add", "origin", L10N_REPO])
    run([*g, "config", "core.sparseCheckout", "true"])
    run([*g, "sparse-checkout", "set", "--no-cone", *[f"/{loc}/" for loc in locales]])
    run([*g, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", rev])
    run([*g, "-c", "advice.detachedHead=false", "checkout", "-q", rev])
    head = run([*g, "rev-parse", "HEAD"], capture=True).stdout.strip()
    if head != rev:
        die(f"firefox-l10n: получена ревизия {head}, ожидалась {rev}")
    stamp.write_text(want)


def cmd_l10n(args: argparse.Namespace) -> None:
    need_engine()
    fetch_l10n(load_config())
    log(f"переводы в {L10N_BASE.relative_to(ROOT)}")


def cmd_reset(args: argparse.Namespace) -> None:
    need_engine()
    log("возвращаю engine/ к чистому Firefox")
    git(["checkout", "-q", "--", "."])
    git(["clean", "-fdq", "-e", "obj-*", "-e", "mozconfig"])
    applied = BUILD_STATE / "applied.json"
    if applied.exists():
        applied.unlink()


def cmd_update(args: argparse.Namespace) -> None:
    config = load_config()
    if args.to:
        latest = args.to
    else:
        with urllib.request.urlopen(PRODUCT_DETAILS, timeout=60) as resp:
            latest = json.load(resp)["LATEST_FIREFOX_VERSION"]
    if not isinstance(latest, str) or not FIREFOX_VERSION_RE.match(latest):
        die(f"неверная версия Firefox: {latest!r}")
    current = config["firefox"]["version"]
    if latest == current:
        log(f"уже последняя версия: {current}")
        return
    sha = mozilla_sha512(latest, f"source/firefox-{latest}.source.tar.xz")
    config["firefox"]["version"] = latest
    config["firefox"]["sha512"] = sha
    save_config(config)
    log(f"Firefox {current} → {latest} (sha512 закреплён в browser.json); дальше: download, import, build")


# ---------------------------------------------------------------------------
# import: брендинг + изменения из src/

def cmd_import(args: argparse.Namespace) -> None:
    need_engine()
    config = load_config()
    brand = brand_name(config, args.brand)
    verify_mar_certs()
    apply_branding(config, brand)
    apply_src()
    write_mozconfig(config, brand)
    log("import завершён")


def apply_branding(config: dict, brand: str) -> None:
    info = config["brands"][brand]
    source = CONFIGS / "branding" / brand
    if not source.exists():
        die(f"нет папки брендинга {source}")
    base = ENGINE / "browser" / "branding" / "unofficial"
    dest = ENGINE / "browser" / "branding" / brand
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(base, dest)
    log(f"брендинг «{brand}» → {dest.relative_to(ROOT)}")

    # Иконки: default<N>.png из logo<N>.png, остальное из папки брендинга как есть
    for size in ICON_SIZES:
        logo = source / f"logo{size}.png"
        if logo.exists():
            shutil.copy(logo, dest / f"default{size}.png")
        else:
            warn(f"нет {logo.name}, остаётся иконка Firefox")
    pairs = [
        ("logo256.png", "content/about-logo.png"),
        ("logo512.png", "content/about-logo@2x.png"),
        ("logo.svg", "content/about-logo.svg"),
        ("logo256.png", "content/about-logo-private.png"),
        ("logo512.png", "content/about-logo-private@2x.png"),
    ]
    for src_name, rel in pairs:
        if (source / src_name).exists():
            shutil.copy(source / src_name, dest / rel)
    for name in ("firefox.icns", "firefox.ico", "firefox64.ico", "document.ico", "document.icns",
                 "disk.icns", "pbmode.ico", "newtab.ico", "newwindow.ico"):
        if (source / name).exists():
            shutil.copy(source / name, dest / name)
    # Любые другие файлы из папки брендинга перекрывают базовые (например, msix/, stubinstaller/)
    for path in source.rglob("*"):
        rel = path.relative_to(source)
        if path.is_file() and not rel.name.startswith("logo") and not rel.name.startswith(".") and rel.name != "README.md":
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, target)

    names = {
        "shorter": info.get("shorterName", config["name"]),
        "short": info.get("shortName", config["name"]),
        "full": info.get("fullName", config["name"]),
        "vendor": config["vendor"],
    }
    # Firefox склеивает CFBundleIdentifier как <appId>.<MOZ_MACBUNDLE_ID>,
    # поэтому в configure.sh идёт только хвост bundleId после appId.
    bundle_id = info.get("bundleId") or f"{config['appId']}.{config['binaryName']}"
    prefix = config["appId"] + "."
    mac_suffix = bundle_id[len(prefix):] if bundle_id.startswith(prefix) else bundle_id.rsplit(".", 1)[-1]
    (dest / "configure.sh").write_text(
        "# This Source Code Form is subject to the terms of the Mozilla Public\n"
        "# License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        "# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n\n"
        f"MOZ_APP_DISPLAYNAME={names['full']}\n"
        f"MOZ_MACBUNDLE_ID={mac_suffix}\n"
    )
    locales = dest / "locales" / "en-US"
    (locales / "brand.ftl").write_text(
        "# This Source Code Form is subject to the terms of the Mozilla Public\n"
        "# License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        "# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n\n"
        f"-brand-shorter-name = {names['shorter']}\n"
        f"-brand-short-name = {names['short']}\n"
        f"-brand-shortcut-name = {names['short']}\n"
        f"-brand-full-name = {names['full']}\n"
        f"-brand-product-name = {names['full']}\n"
        f"-vendor-short-name = {names['vendor']}\n"
        'trademarkInfo = { " " }\n'
    )
    (locales / "brand.properties").write_text(
        "# This Source Code Form is subject to the terms of the Mozilla Public\n"
        "# License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        "# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n\n"
        f"brandShorterName={names['shorter']}\n"
        f"brandShortName={names['short']}\n"
        f"brandFullName={names['full']}\n"
    )
    urls = info.get("urls", {})
    home = urls.get("homepage") or "about:blank"

    def pref(name: str, value: str) -> str:
        return f'pref("{name}", "{value}");\n' if value else ""

    (dest / "pref" / "firefox-branding.js").write_text(
        "/* This Source Code Form is subject to the terms of the Mozilla Public\n"
        " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\n"
        + pref("startup.homepage_override_url", urls.get("whatsnew", ""))
        + pref("startup.homepage_welcome_url", urls.get("welcome", ""))
        + pref("startup.homepage_welcome_url.additional", urls.get("privacy", ""))
        + 'pref("app.update.interval", 86400);\n'
        + 'pref("app.update.promptWaitTime", 691200);\n'
        + pref("app.update.url.manual", urls.get("download") or home)
        + pref("app.update.url.details", urls.get("releaseNotes") or home)
        + pref("app.releaseNotesURL", urls.get("releaseNotes") or home)
        + pref("app.releaseNotesURL.aboutDialog", urls.get("releaseNotes") or home)
        + pref("app.releaseNotesURL.prompt", urls.get("releaseNotes") or home)
        + 'pref("app.update.checkInstallTime.days", 2);\n'
        + 'pref("app.update.badgeWaitTime", 0);\n'
        # предупреждение о вставке кода в консоль не снимается заранее (защита от self-XSS)
        + 'pref("devtools.selfxss.count", 0);\n'
        + pref("tabora.version", info.get("displayVersion", "0.0.0"))
        + pref("tabora.url.homepage", home)
        + pref("tabora.url.help", urls.get("help") or home)
        + pref("tabora.url.releaseNotes", urls.get("releaseNotes") or home)
        + pref("tabora.url.terms", urls.get("terms") or home)
        + pref("tabora.url.privacy", urls.get("privacy") or home)
        + product_prefs(brand)
    )
    nsi = dest / "branding.nsi"
    if nsi.exists():
        text = nsi.read_text()
        for old, new in (
            ('BrandFullNameInternal "Nightly"', f'BrandFullNameInternal "{names["full"]}"'),
            ('BrandFullName         "Nightly"', f'BrandFullName         "{names["full"]}"'),
            ('CompanyName           "Mozilla"', f'CompanyName           "{names["vendor"]}"'),
            ('URLInfoAbout          "https://www.mozilla.org"', f'URLInfoAbout          "{home}"'),
            ('HelpLink              "https://support.mozilla.org/"', f'HelpLink              "{urls.get("help") or home}"'),
        ):
            text = text.replace(old, new)
        nsi.write_text(text)


def product_prefs(brand: str) -> str:
    """Наши настройки по умолчанию из configs/prefs/: common.js и <brand>.js."""
    parts = []
    for name in ("common", brand):
        path = CONFIGS / "prefs" / f"{name}.js"
        if path.exists():
            parts.append(f"\n// ---- configs/prefs/{name}.js ----\n" + path.read_text())
    return "".join(parts)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _engine_file_hash(rel: str) -> str:
    path = ENGINE / rel
    if path.is_symlink() or not path.is_file():
        return ""
    return _sha256_bytes(path.read_bytes())


def _patch_targets(patch: Path) -> List[str]:
    out = run(["git", "apply", "--numstat", str(patch)], cwd=ENGINE, capture=True).stdout
    files = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and " => " not in parts[2]:
            files.append(parts[2])
    return files


def _load_applied() -> Dict[str, dict]:
    """applied.json: {"patches": {путь патча: {"sha256": хеш патча, "files": {файл: хеш после наложения}}}}.
    Старый формат (список путей) читается как «наложен, содержимое неизвестно»."""
    path = BUILD_STATE / "applied.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return {key: {"sha256": None, "files": {}} for key in data}
    return data.get("patches", {})


def _save_applied(state: Dict[str, dict]) -> None:
    (BUILD_STATE / "applied.json").write_text(json.dumps({"version": 2, "patches": state}, indent=2, sort_keys=True))


def _restore_pristine(files: List[str]) -> None:
    for rel in files:
        tracked = run(["git", "cat-file", "-e", f"HEAD:{rel}"], cwd=ENGINE, check=False, capture=True).returncode == 0
        if tracked:
            git(["checkout", "-q", "HEAD", "--", rel])
        elif (ENGINE / rel).exists() or (ENGINE / rel).is_symlink():
            (ENGINE / rel).unlink()


def apply_src() -> None:
    """src/ зеркалит дерево Firefox: *.patch накладываются git apply,
    остальные файлы подключаются символическими ссылками, чтобы правки в src/
    сразу попадали в сборку. Хеш каждого патча хранится в .build/applied.json:
    если патч в src/ изменился, файлы движка возвращаются к Firefox и патч
    накладывается заново (если их не правили вручную после наложения)."""
    BUILD_STATE.mkdir(exist_ok=True)
    state = _load_applied()
    patches, files = 0, 0
    try:
        for path in sorted(SRC.rglob("*")):
            if not path.is_file() or path.name == ".gitkeep":
                continue
            rel = path.relative_to(SRC)
            if path.suffix == ".patch":
                key = str(rel)
                digest = _sha256_bytes(path.read_bytes())
                entry = state.get(key)
                if entry and entry.get("sha256") == digest:
                    continue
                targets = _patch_targets(path)
                reverse = run(["git", "apply", "--check", "-R", str(path)], cwd=ENGINE, check=False, capture=True)
                if reverse.returncode == 0:
                    # движок уже содержит именно этот патч (например, правка сделана в engine/ и экспортирована)
                    state[key] = {"sha256": digest, "files": {f: _engine_file_hash(f) for f in targets}}
                    continue
                if entry:
                    # наложена прежняя версия патча: вернуть файлы к Firefox, если их не трогали руками
                    known = entry.get("files") or {}
                    touched = sorted(set(targets) | set(known))
                    for f in touched:
                        if not known or _engine_file_hash(f) != known.get(f, ""):
                            pristine = run(["git", "diff", "--quiet", "HEAD", "--", f], cwd=ENGINE, check=False).returncode == 0
                            if not pristine:
                                die(f"патч {rel} изменился, а engine/{f} правили после наложения: "
                                    f"сохраните правки (tools/build.py export) или верните файл "
                                    f"(git -C engine checkout HEAD -- {f}) и повторите import")
                    _restore_pristine(touched)
                check = run(["git", "apply", "--check", str(path)], cwd=ENGINE, check=False, capture=True)
                if check.returncode != 0:
                    die(f"патч {rel} не накладывается:\n{check.stderr}")
                run(["git", "apply", str(path)], cwd=ENGINE)
                state[key] = {"sha256": digest, "files": {f: _engine_file_hash(f) for f in targets}}
                patches += 1
            else:
                target = ENGINE / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.is_symlink() or target.exists():
                    if target.is_symlink() and os.readlink(target) == str(path):
                        continue
                    target.unlink()
                target.symlink_to(path)
                files += 1
    finally:
        _save_applied(state)
    log(f"src/: наложено патчей {patches}, подключено файлов {files}")


def cmd_export(args: argparse.Namespace) -> None:
    """Правки, сделанные прямо в engine/ (не через src/), сохраняются как патчи."""
    need_engine()
    changed = git(["diff", "--name-only", "--diff-filter=M"]).splitlines()
    exported = 0
    for rel in changed:
        if rel.startswith("browser/branding/") or rel == "mozconfig":
            continue
        if (ENGINE / rel).is_symlink():
            continue
        # сырой вывод без strip(): хвостовые пустые строки контекста — часть патча
        diff = run(["git", "diff", "--", rel], cwd=ENGINE, capture=True).stdout
        if not diff.strip():
            continue
        target = SRC / (rel + ".patch")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(diff)
        exported += 1
        log(f"→ {target.relative_to(ROOT)}")
    if not exported:
        log("нечего экспортировать")


# ---------------------------------------------------------------------------
# mozconfig, bootstrap, build, run, package

def write_mozconfig(config: dict, brand: str) -> Path:
    info = config["brands"][brand]
    plat = target_platform()
    changeset = git(["rev-parse", "--short", "HEAD"], cwd=ROOT, check=False) or "unknown"
    app_basename = config["name"].replace(" ", "")
    # Хост для [AppUpdate] URL в application.ini (иначе Firefox подставит aus5.mozilla.org).
    # Сам адрес не используется: update.xml берётся из tabora.update.url (настройки по умолчанию).
    update_host = config.get("updateHost") or "tabora.app"
    if not HOST_RE.match(update_host) or update_host.endswith("mozilla.org"):
        die(f"неверный updateHost в browser.json: {update_host!r}")
    version = info.get("displayVersion", "")
    if not TABORA_VERSION_RE.match(version):
        die(f"displayVersion бренда {brand} должна быть вида X.Y.Z, сейчас {version!r}")
    L10N_BASE.mkdir(parents=True, exist_ok=True)
    # --target только для кросс-сборки: на родной машине mach сам определяет цель,
    # а явный триплет без версии ОС заставляет configure считать сборку кросс-компиляцией
    cross = plat != host_platform() or target_arch() != host_arch()
    target_line = f"ac_add_options --target={target_triple()}" if cross else "# родная сборка: --target не задаём"
    header = f"""# Сгенерировано tools/build.py, не редактировать: правьте configs/*/mozconfig
mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-{plat}-{target_arch()}

ac_add_options --with-app-name={config['binaryName']}
ac_add_options --with-app-basename={app_basename}
ac_add_options --with-branding=browser/branding/{brand}
ac_add_options --with-distribution-id={config['appId']}
ac_add_options --enable-update-channel={brand}
ac_add_options --with-l10n-base="{L10N_BASE}"
{target_line}

export MOZ_APPUPDATE_HOST={update_host}
export MOZ_SOURCE_REPO={config.get('repository', '')}
export MOZ_SOURCE_CHANGESET={changeset}
export MOZ_INCLUDE_SOURCE_INFO=1
export BROWSER_DISPLAY_VERSION={version}
# версия Tabora: обновлятор не примет MAR с версией ниже (browser/moz.configure)
export TABORA_APP_VERSION={version}
export BROWSER_BRAND={brand}
export TARGET_PLATFORM={plat}
export TARGET_ARCH={target_arch()}
"""
    parts = [header]
    for name in ("common", plat):
        path = CONFIGS / name / "mozconfig"
        if path.exists():
            parts.append(f"\n# ---- configs/{name}/mozconfig ----\n" + path.read_text())
    out = ENGINE / "mozconfig"
    out.write_text("\n".join(parts))
    return out


def cmd_bootstrap(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    log("ставлю тулчейны Mozilla (mach bootstrap), это долго при первом запуске")
    mach(["--no-interactive", "bootstrap", "--application-choice", "browser"], config, brand)


def cmd_build(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    verify_mar_certs()
    if args.ui:
        log("пересборка интерфейса (mach build faster)")
        mach(["build", "faster"], config, brand)
    else:
        log(f"полная сборка {target_platform()}/{target_arch()}, бренд «{brand}»")
        mach(["build"], config, brand)


def cmd_run(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    mach(["run", "--noprofile", *args.args], config, brand)


# ---------------------------------------------------------------------------
# Проверки сертификатов и упакованного приложения (используются и tools/release.py)

def verify_mar_certs() -> None:
    """Сертификаты MAR в src/ (и то, что видит движок) совпадают с закреплёнными отпечатками."""
    for name, expected in MAR_CERT_SHA256.items():
        path = MAR_CERTS_DIR / name
        if not path.is_file() or _sha256_bytes(path.read_bytes()) != expected:
            die(f"сертификат {path.relative_to(ROOT)} не совпадает с закреплённым в tools/build.py: "
                "подмена ключа обновлений?")
        engine_copy = ENGINE / "toolkit" / "mozapps" / "update" / "updater" / name
        if engine_copy.exists() and _sha256_bytes(engine_copy.read_bytes()) != expected:
            die(f"в engine/ лежит другой {name}: выполните tools/build.py import")


def _mar_cert_bytes() -> List[bytes]:
    verify_mar_certs()
    return [(MAR_CERTS_DIR / name).read_bytes() for name in sorted(MAR_CERT_SHA256)]


def _read_omni_pref(omni: Path, name: str) -> Optional[str]:
    import zipfile
    try:
        with zipfile.ZipFile(omni) as z:
            for entry in z.namelist():
                if entry.startswith("defaults/preferences/") and entry.endswith(".js"):
                    text = z.read(entry).decode("utf-8", "replace")
                    m = re.search(r'pref\("' + re.escape(name) + r'",\s*"([^"]*)"\)', text)
                    if m:
                        return m.group(1)
    except (OSError, zipfile.BadZipFile):
        return None
    return None


def verify_packaged_app(app: Path, plat: str, config: dict) -> None:
    """Упакованное приложение пригодно для выпуска: в обновляторе наши сертификаты MAR,
    принимаемый канал tabora-release, версия Tabora совпадает с browser.json, в
    application.ini нет адреса Mozilla. Любое расхождение останавливает выпуск."""
    certs = _mar_cert_bytes()
    problems = []
    if plat == "darwin":
        res = app / "Contents" / "Resources"
        updaters = [app / "Contents" / "MacOS" / "updater.app" / "Contents" / "MacOS" / "org.mozilla.updater",
                    app / "Contents" / "Library" / "LaunchServices" / "org.mozilla.updater"]
        updaters += [p for p in app.rglob("org.mozilla.updater") if p.is_file() and p not in updaters]
        settings = [app / "Contents" / "MacOS" / "updater.app" / "Contents" / "Frameworks" /
                    "UpdateSettings.framework" / "UpdateSettings"]
    else:
        res = app
        updaters = [app / "updater"]
        settings = [app / "update-settings.ini"]
    for path in updaters:
        if not path.is_file():
            problems.append(f"нет обновлятора {path.relative_to(app)}")
            continue
        data = path.read_bytes()
        for cert, name in zip(certs, sorted(MAR_CERT_SHA256)):
            if cert not in data:
                problems.append(f"в {path.relative_to(app)} нет сертификата {name} (старая сборка обновлятора?)")
    for path in settings:
        if not path.is_file():
            problems.append(f"нет {path.relative_to(app)}")
            continue
        data = path.read_bytes()
        if plat == "darwin":
            ok = MAR_CHANNEL_ID.encode() in data
        else:
            ok = re.search(rb"^ACCEPTED_MAR_CHANNEL_IDS=" + re.escape(MAR_CHANNEL_ID.encode()) + rb"\s*$", data, re.M)
        if not ok:
            problems.append(f"в {path.relative_to(app)} нет канала {MAR_CHANNEL_ID}")
    ini = res / "application.ini"
    if not ini.is_file():
        problems.append("нет application.ini")
    else:
        update_url = re.search(r"^\[AppUpdate\]\s*^URL=(.*)$", ini.read_text(), re.M)
        if update_url and "mozilla." in update_url.group(1):
            problems.append("в application.ini адрес обновлений Mozilla (MOZ_APPUPDATE_HOST не применён)")
    brand = config["brands"][config.get("brand", "release")]
    want = brand.get("displayVersion")
    got = _read_omni_pref(res / "browser" / "omni.ja", "tabora.version")
    if got != want:
        problems.append(f"версия Tabora в приложении {got!r}, в browser.json {want!r}")
    if problems:
        die("упакованное приложение не годится для выпуска:\n  " + "\n  ".join(problems))
    log("обновлятор: сертификаты Tabora, канал " + MAR_CHANNEL_ID + f", версия {want}")


def packaged_app_path(plat: str) -> Path:
    stage = objdir() / "dist" / "tabora"
    return stage / "Tabora.app" if plat == "darwin" else stage


def _prepare_distribution_dir() -> None:
    """Языковые пакеты больше не кладутся в distribution/extensions (перевод встроен
    multi-locale сборкой, неподписанные пакеты при обязательной подписи не работают).
    Старые копии из dist/bin убираются. Пока package-manifest.in.patch требует
    @RESPATH@/distribution/*, нужен хотя бы один файл, иначе упаковщик падает."""
    dist_bin = objdir() / "dist" / "bin"
    ext = dist_bin / "distribution" / "extensions"
    for xpi in ext.glob("langpack-*.xpi") if ext.exists() else []:
        xpi.unlink()
        log(f"убран старый языковой пакет {xpi.name}")
    if ext.exists() and not any(ext.iterdir()):
        ext.rmdir()
    manifest = ENGINE / "browser" / "installer" / "package-manifest.in"
    text = manifest.read_text() if manifest.exists() else ""
    unconditional = re.search(r"^; Tabora: .*\n@RESPATH@/distribution/\*$", text, re.M)
    dist = dist_bin / "distribution"
    if unconditional and not (dist.exists() and any(p.is_file() for p in dist.rglob("*"))):
        dist.mkdir(parents=True, exist_ok=True)
        (dist / "README.txt").write_text(
            "Tabora: distribution/ is intentionally empty (no bundled add-ons).\n")


def cmd_package(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    verify_mar_certs()
    _prepare_distribution_dir()
    locales = [loc for loc in config.get("locales", []) if loc != "en-US"]
    if locales:
        # Перевод встраивается в сборку (omni.ja), а не отдельным неподписанным пакетом
        fetch_l10n(config)
        mach(["package-multi-locale", "--locales", "en-US", *locales], config, brand)
    else:
        mach(["package"], config, brand)
    app = packaged_app_path(target_platform())
    verify_packaged_app(app, target_platform(), config)
    DIST.mkdir(exist_ok=True)
    dist_dir = objdir() / "dist"
    copied = 0
    for pattern in ("*.dmg", "*.tar.xz", "*.tar.bz2", "*.zip", "*.exe", "*.msix"):
        for artifact in dist_dir.glob(pattern):
            shutil.copy(artifact, DIST / artifact.name)
            log(f"→ dist/{artifact.name}")
            copied += 1
    if not copied:
        warn(f"в {dist_dir} нет упакованных файлов")
    if args.app_tar:
        # приложение для tools/release.py в CI: tar сохраняет ссылки как ссылки
        name = f"tabora-app-{target_platform()}-{target_arch()}.tar"
        out = DIST / name
        run(["tar", "-cf", str(out), "-C", str(app.parent), app.name])
        log(f"→ dist/{name}")


def cmd_status(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    version_file = BUILD_STATE / "engine-version"
    print(f"Продукт:     {config['name']} ({config['binaryName']}), бренд «{brand}», "
          f"версия {config['brands'][brand].get('displayVersion')}")
    print(f"Firefox:     {config['firefox']['version']} в browser.json, "
          f"{version_file.read_text().strip() if version_file.exists() else 'не скачан'} в engine/")
    print(f"Цель:        {target_platform()}/{target_arch()} ({target_triple()})"
          + (" кросс-сборка" if target_platform() != host_platform() else ""))
    print(f"Объекты:     {objdir().relative_to(ROOT)}{'' if objdir().exists() else ' (ещё не собирали)'}")
    if (ENGINE / "mach").exists():
        changed = git(["status", "--short"]).splitlines()
        print(f"engine/:     изменённых файлов {len(changed)}")


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(prog="tools/build.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--brand", help="бренд из browser.json (по умолчанию из поля brand)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("download", help="скачать исходники Firefox")
    p.add_argument("--force", action="store_true", help="перекачать, даже если версия совпадает")
    p.set_defaults(fn=cmd_download)
    sub.add_parser("import", help="наложить брендинг и src/").set_defaults(fn=cmd_import)
    sub.add_parser("export", help="сохранить правки из engine/ как патчи").set_defaults(fn=cmd_export)
    sub.add_parser("reset", help="вернуть engine/ к чистому Firefox").set_defaults(fn=cmd_reset)
    sub.add_parser("bootstrap", help="поставить тулчейны Mozilla").set_defaults(fn=cmd_bootstrap)
    p = sub.add_parser("build", help="собрать")
    p.add_argument("--ui", action="store_true", help="только интерфейс, без компиляции движка")
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser("run", help="запустить собранный браузер")
    p.add_argument("args", nargs="*")
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("package", help="упаковать в dist/")
    p.add_argument("--app-tar", action="store_true", help="также положить в dist/ tar упакованного приложения (для выпуска в CI)")
    p.set_defaults(fn=cmd_package)
    sub.add_parser("l10n", help="скачать переводы для locales из browser.json").set_defaults(fn=cmd_l10n)
    p = sub.add_parser("update", help="обновить версию Firefox в browser.json")
    p.add_argument("--to", help="конкретная версия, иначе последняя")
    p.set_defaults(fn=cmd_update)
    sub.add_parser("status", help="состояние проекта").set_defaults(fn=cmd_status)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
