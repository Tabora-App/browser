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
  verify [--dev]  проверить упакованное приложение: годится ли для распространения
  update [--to V] обновить версию Firefox в browser.json (по умолчанию до последней)
  status          показать версию, бренд и платформу

Переменные окружения:
  TARGET_PLATFORM  darwin | linux (по умолчанию хост)
  TARGET_ARCH      aarch64 | x86_64 (по умолчанию хост)
  BROWSER_RELEASE  1 = сборка для распространения (MOZILLA_OFFICIAL, оптимизации, без тестов).
                   Задаётся одинаково для build и package. Без неё package делает пакет
                   для разработки: файлы в dist/ получают суффикс -dev, распространять нельзя.
  BROWSER_DISABLE_LTO, BROWSER_DISABLE_BOOTSTRAP  см. configs/common/mozconfig
  TABORA_SAFEBROWSING_KEYFILE  файл ключа Google Safe Browsing (по умолчанию
                   ~/.config/tabora/safebrowsing.key, если он есть). Без ключа удалённая
                   проверка загрузок выключается настройкой (данные не уходят в Google).

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
TEAM_ID_RE = re.compile(r"^[A-Z0-9]{10}$")
MOZILLA_TEAM_ID = "43AQ936H96"
NO_SAFEBROWSING_KEY = "no-google-safebrowsing-api-key"
# Android: приложение собирается из mobile/android/fenix типом сборки release; имя пакета задаёт
# src/mobile/android/fenix/app/build.gradle.patch, здесь оно сверяется в готовом файле
ANDROID_BUILD_TYPE = "release"
ANDROID_APP_ID = "app.tabora.browser"
ANDROID_ABI = "arm64-v8a"
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
    if plat == "android":
        if arch != "aarch64":
            die("для Android собирается только aarch64 (телефоны arm64-v8a): задайте TARGET_ARCH=aarch64")
        return "aarch64-linux-android"
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


def is_release_env() -> bool:
    """BROWSER_RELEASE задана: сборка и пакет для распространения."""
    return bool(os.environ.get("BROWSER_RELEASE"))


def safebrowsing_keyfile() -> Optional[Path]:
    """Файл ключа Google Safe Browsing, если он есть и не пуст (то же условие, что в
    configs/common/mozconfig)."""
    path = Path(os.environ.get("TABORA_SAFEBROWSING_KEYFILE")
                or Path.home() / ".config" / "tabora" / "safebrowsing.key")
    try:
        return path if path.is_file() and path.stat().st_size > 0 else None
    except OSError:
        return None


def mac_team_id(config: dict) -> str:
    """Apple Team ID сертификата подписи (macTeamId в browser.json): им связаны приложение и
    привилегированный помощник обновления (SMPrivilegedExecutables / SMAuthorizedClients)."""
    team = config.get("macTeamId")
    if not isinstance(team, str) or not TEAM_ID_RE.match(team) or team == MOZILLA_TEAM_ID:
        die(f"неверный macTeamId в browser.json: {team!r} (нужен свой Team ID из 10 знаков)")
    return team


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
    write_branding_prefs(config, brand)
    if is_release_env() and not safebrowsing_keyfile():
        warn("релизная сборка без ключа Safe Browsing (~/.config/tabora/safebrowsing.key или "
             "TABORA_SAFEBROWSING_KEYFILE): защита от фишинга и вредоносных загрузок работать не будет")
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
    """sha512 файла релиза Firefox из SHA512SUMS archive.mozilla.org с проверкой подписи
    Mozilla (gpg). Без gpg хеш не принимается и не закрепляется: это ошибка, кроме
    осознанного пропуска общим флагом --no-gpg (tools/build.py --no-gpg update …)."""
    base = RELEASES.format(v=version)
    sums = _fetch(base + "SHA512SUMS")
    verified = _gpg_verify(sums, _fetch(base + "SHA512SUMS.asc"), _fetch(base + "KEY"))
    if verified is False:
        die("подпись SHA512SUMS не проверена ключом Mozilla " + MOZILLA_RELEASE_KEY)
    if verified is None:
        if "--no-gpg" not in sys.argv[1:]:
            die("gpg не установлен: подпись SHA512SUMS не проверена, хеш исходников не закрепляется. "
                "Поставьте gpg (brew install gnupg) или осознанно пропустите проверку: tools/build.py --no-gpg …")
        warn("--no-gpg: подпись SHA512SUMS НЕ проверена, хеш получен только по https — "
             "сверьте firefox.sha512 в browser.json на машине с gpg перед коммитом")
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
        rebrand_l10n(config)
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
    rebrand_l10n(config)


# Названия возможностей браузера, в которых Mozilla пишет «Firefox» независимо от бренда сборки
# («Домашняя страница Firefox»). Названия сервисов Mozilla (Relay, Monitor, VPN) не трогаем:
# это чужие продукты, и в интерфейсе Tabora их разделы скрыты.
REBRAND_TERMS = ("-firefox-home-brand-name", "-firefoxview-brand-name", "-firefoxlabs-brand-name", "-firefox-suggest-brand-name")


def rebrand_terms(path: Path, brand: str = "Tabora") -> bool:
    """В brandings.ftl заменяет «Firefox» на бренд сборки внутри терминов REBRAND_TERMS.
    Повторный вызов ничего не меняет. Возвращает True, если файл изменён."""
    if not path.is_file():
        return False
    out, inside, changed = [], False, False
    for line in path.read_text(encoding="utf-8").splitlines(keepends=True):
        if line[:1] not in (" ", "\t", "\n", "#", ""):
            # начало нового термина или сообщения
            inside = line.split("=")[0].strip() in REBRAND_TERMS
        if inside and "Firefox" in line and not line.lstrip().startswith("#"):
            line = line.replace("Firefox", brand)
            changed = True
        out.append(line)
    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def rebrand_l10n(config: dict) -> None:
    """Термины с «Firefox» в загруженных переводах. Вызывается из fetch_l10n при каждом
    обращении: выборка переводов пересоздаётся только при смене ревизии."""
    for loc in [loc for loc in config.get("locales", []) if loc != "en-US"]:
        if rebrand_terms(L10N_BASE / loc / "toolkit" / "toolkit" / "branding" / "brandings.ftl"):
            log(f"перевод {loc}: названия возможностей с «Firefox» заменены на Tabora")


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
    # до переноса проверяются только сертификаты в src/: в свежей копии движка ещё лежат
    # сертификаты Mozilla, наши туда кладёт apply_src; копия в engine/ сверяется после него
    verify_mar_certs(engine=False)
    apply_branding(config, brand)
    apply_src()
    verify_mar_certs()
    if target_platform() == "android":
        rebrand_android_strings()
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
    write_branding_prefs(config, brand)
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


def branding_prefs_text(config: dict, brand: str) -> str:
    """Содержимое branding/pref/firefox-branding.js: адреса из browser.json, настройки из
    configs/prefs/ и настройки, зависящие от окружения сборки (ключ Safe Browsing)."""
    info = config["brands"][brand]
    urls = info.get("urls", {})
    home = urls.get("homepage") or "about:blank"

    def pref(name: str, value: str) -> str:
        return f'pref("{name}", "{value}");\n' if value else ""

    # Safe Browsing: с ключом-заглушкой запросы к Google бесполезны, а удалённая проверка
    # загрузок всё равно отправляет адрес и сведения о файле. Без ключа она выключена.
    if safebrowsing_keyfile():
        safebrowsing = ('// Safe Browsing: ключ Google есть, удалённая проверка загрузок включена\n'
                        'pref("browser.safebrowsing.downloads.remote.enabled", true);\n')
    else:
        safebrowsing = ('// Safe Browsing: сборка без ключа Google — сведения о загрузках не отправляются\n'
                        'pref("browser.safebrowsing.downloads.remote.enabled", false);\n'
                        'pref("browser.safebrowsing.downloads.remote.url", "");\n')
    return (
        "/* This Source Code Form is subject to the terms of the Mozilla Public\n"
        " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\n"
        + pref("startup.homepage_override_url", urls.get("whatsnew", ""))
        + pref("startup.homepage_welcome_url", urls.get("welcome", ""))
        + pref("startup.homepage_welcome_url.additional", urls.get("privacy", ""))
        # app.update.interval задаётся в configs/prefs/<brand>.js
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
        + safebrowsing
        + product_prefs(brand)
    )


def write_branding_prefs(config: dict, brand: str) -> None:
    """Перезаписывает firefox-branding.js, если содержимое изменилось. Вызывается из import и
    перед каждым mach: настройки следуют за configs/prefs/ и за наличием ключа Safe Browsing
    в тот же момент, когда mozconfig решает, передавать ли ключ в сборку."""
    target = ENGINE / "browser" / "branding" / brand / "pref" / "firefox-branding.js"
    if not target.parent.is_dir():
        return  # брендинг ещё не наложен (bootstrap до import)
    text = branding_prefs_text(config, brand)
    if not target.exists() or target.read_text() != text:
        target.write_text(text)


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
        if rel.startswith("mobile/android/") and "/res/values" in rel and rel.endswith(ANDROID_STRING_FILES):
            # название в надписях Android заменяет rebrand_android_strings, патчи не нужны
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

def write_android_mozconfig(config: dict, brand: str, changeset: str) -> Path:
    """mozconfig для Android: движок GeckoView и приложение (mobile/android/fenix) из одного дерева.
    Имя пакета, название и версия приложения задаются не здесь, а в его настройках сборки
    (src/mobile/android/fenix/app/build.gradle.patch) и параметрами gradle в cmd_build."""
    header = f"""# Сгенерировано tools/build.py, не редактировать: правьте configs/android/mozconfig
mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-android-{target_arch()}

ac_add_options --target={target_triple()}
ac_add_options --with-branding=mobile/android/branding/tabora
ac_add_options --enable-update-channel={brand}
ac_add_options --with-l10n-base="{L10N_BASE}"

export MOZ_SOURCE_REPO={config.get('repository', '')}
export MOZ_SOURCE_CHANGESET={changeset}
export MOZ_INCLUDE_SOURCE_INFO=1
export BROWSER_BRAND={brand}
export TARGET_PLATFORM=android
export TARGET_ARCH={target_arch()}
"""
    L10N_BASE.mkdir(parents=True, exist_ok=True)
    path = CONFIGS / "android" / "mozconfig"
    out = ENGINE / "mozconfig"
    out.write_text(header + "\n# ---- configs/android/mozconfig ----\n" + path.read_text())
    return out


def write_mozconfig(config: dict, brand: str) -> Path:
    info = config["brands"][brand]
    plat = target_platform()
    changeset = git(["rev-parse", "--short", "HEAD"], cwd=ROOT, check=False) or "unknown"
    if plat == "android":
        return write_android_mozconfig(config, brand, changeset)
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
    # Team ID только для macOS: опция configure объявлена при target_is_osx
    team_line = f"export TABORA_MAC_TEAM_ID={mac_team_id(config)}\n" if plat == "darwin" else ""
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
{team_line}"""
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
    # для Android bootstrap ставит ещё Android SDK, NDK и JDK в ~/.mozbuild
    choice = "mobile_android" if target_platform() == "android" else "browser"
    mach(["--no-interactive", "bootstrap", "--application-choice", choice], config, brand)


def dev_resource_roots() -> list[Path]:
    """Каталоги ресурсов сборки разработчика: dist/bin и, на macOS, его копия в пакете приложения."""
    dist = objdir() / "dist"
    bundles = sorted(app / "Contents" / "Resources" for app in dist.glob("*.app"))
    return [dist / "bin", *[res for res in bundles if (res / "chrome.manifest").is_file()]]


def register_dev_locales(config: dict) -> None:
    """Возвращает встроенные переводы в сборку разработчика (dist/bin).

    Файлы перевода (chrome/<язык>, localization/<язык>, с брендом Tabora) попадают в dist/bin
    при упаковке (package-multi-locale) и остаются там, но mach build пересоздаёт общий
    chrome.manifest и список языков только с en-US, и приложение из dist/ про перевод не знает.
    Раньше русский в такой сборке давал языковой пакет-дополнение с нашим брендом; с обязательной
    подписью дополнений он отключается, а менеджер дополнений сам заменяет его официальным
    пакетом Mozilla, где бренд — Firefox. Поэтому перевод включается здесь, без дополнений.

    На macOS запущенное приложение читает не dist/bin, а его копию внутри пакета
    (dist/<имя>.app/Contents/Resources): сборка переносит туда файлы раньше, чем эта функция
    допишет манифест. Без строки в манифесте пакета строки из .properties (меню инструментов
    разработчика, диалоги, загрузки) остаются английскими, хотя Fluent уже русский."""
    roots = dev_resource_roots()
    ready = []
    for loc in [loc for loc in config.get("locales", []) if loc != "en-US"]:
        bases = [base for root in roots for base in (root, root / "browser")]
        if not all((base / "chrome" / f"{loc}.manifest").is_file() for base in bases):
            log(f"перевод {loc} в dist/bin не собран (появится после tools/build.py package)")
            continue
        for base in bases:
            top = base / "chrome.manifest"
            line = f"manifest chrome/{loc}.manifest"
            text = top.read_text() if top.is_file() else ""
            if line not in text.splitlines():
                top.write_text(text.rstrip("\n") + "\n" + line + "\n")
        for root in roots:
            rebrand_terms(root / "localization" / loc / "toolkit" / "branding" / "brandings.ftl")
        ready.append(loc)
    # dist/bin/res/multilocale.txt — ссылка на этот файл; формат как у gen_multilocale.py
    listing = objdir() / "toolkit" / "locales" / "multilocale.txt"
    want = ",".join(["en-US", *ready])
    if listing.is_file() and listing.read_text().strip() != want:
        listing.write_text(want + "\n")
    if ready:
        log(f"встроенные переводы в dist/bin: {', '.join(ready)}")


# ---------------------------------------------------------------------------
# Android

ANDROID_STRING_FILES = ("strings.xml", "static_strings.xml")
_XML_COMMENT_RE = re.compile(r"(<!--.*?-->)", re.S)


def rebrand_android_strings() -> None:
    """Название в надписях приложения для Android: «Firefox» → название продукта.

    У приложения название почти везде подставляется из app_name, но в части надписей (в каждом из
    ~90 переводов) оно написано прямо. Править это патчами — сотни файлов, поэтому замена делается
    здесь, по месту в engine/, только для цели android. Комментарии переводчикам и адреса
    (firefox.com — строчными) не трогаются; файлы, подключённые из src/, тоже."""
    need_engine()
    brand = load_config()["name"]
    android = ENGINE / "mobile" / "android"
    roots = [android / "fenix" / "app" / "src", android / "android-components" / "components"]
    changed = 0
    for root in roots:
        for name in ANDROID_STRING_FILES:
            for path in root.glob(f"**/res/values*/{name}"):
                if path.is_symlink():
                    continue
                text = path.read_text(encoding="utf-8")
                parts = _XML_COMMENT_RE.split(text)
                new = "".join(part if part.startswith("<!--") else part.replace("Firefox", brand) for part in parts)
                if new != text:
                    path.write_text(new, encoding="utf-8")
                    changed += 1
    log(f"надписи приложения для Android: название заменено в {changed} файлах" if changed
        else "надписи приложения для Android: название уже заменено")


def _apk_problems(apk: Path) -> List[str]:
    """Готовый файл приложения: тот ли это продукт и всё ли в нём на месте."""
    import io
    import zipfile
    problems = []
    try:
        with zipfile.ZipFile(apk) as z:
            names = set(z.namelist())
            for need in (f"lib/{ANDROID_ABI}/libxul.so", "assets/omni.ja", "AndroidManifest.xml", "classes.dex"):
                if need not in names:
                    problems.append(f"в {apk.name} нет {need}")
            manifest = z.read("AndroidManifest.xml") if "AndroidManifest.xml" in names else b""
            # общий пользователь с Firefox (sharedUserId): с ним приложение не встанет на телефон,
            # где уже есть Firefox, — подписи разные
            if b"sharedID" in manifest or "sharedID".encode("utf-16-le") in manifest:
                problems.append(f"в описании приложения остался общий пользователь с Firefox (sharedUserId): "
                                f"пакет должен быть {ANDROID_APP_ID} без него")
            if ANDROID_APP_ID.encode() not in manifest and ANDROID_APP_ID.encode("utf-16-le") not in manifest:
                problems.append(f"имя пакета в {apk.name} не {ANDROID_APP_ID}")
            if any(n.startswith("META-INF/") and n.endswith((".RSA", ".DSA", ".EC")) for n in names):
                problems.append(f"{apk.name} уже подписан: сборка должна отдавать неподписанный файл "
                                "(подпись — tools/android/sign.sh)")
            if "assets/omni.ja" in names:
                # omni.ja для Android упакован «оптимизированно» (оглавление в начале файла), и
                # zipfile его не открывает; имена файлов в оглавлении записаны как есть — ищем их
                omni = z.read("assets/omni.ja")
                for rel in ("shield/Shield.sys.mjs", "shield/ShieldEngine.sys.mjs",
                            "actors/TaboraShieldParent.sys.mjs", "actors/TaboraShieldChild.sys.mjs"):
                    if f"chrome/geckoview/content/tabora/{rel}".encode() not in omni:
                        problems.append(f"в движке нет блокировщика рекламы: chrome/geckoview/content/tabora/{rel}")
    except (OSError, zipfile.BadZipFile) as e:
        problems.append(f"{apk.name} не читается: {e}")
    return problems


def _apk_has_engine_locale(apk: Path, locale: str) -> bool:
    """Есть ли в готовом файле перевод служебных страниц движка на этот язык (по именам файлов
    в оглавлении omni.ja; сам архив zipfile не открывает, см. _apk_problems)."""
    import zipfile
    try:
        with zipfile.ZipFile(apk) as z:
            omni = z.read("assets/omni.ja")
    except (OSError, KeyError, zipfile.BadZipFile):
        return False
    return f"localization/{locale}/".encode() in omni or f"chrome/{locale}/locale/".encode() in omni


def package_android(config: dict, brand: str) -> None:
    """Кладёт собранное приложение в dist/ и проверяет его. Файл неподписанный: поставить его
    на телефон нельзя, пока он не подписан ключом Tabora (tools/android/sign.sh)."""
    version = config["brands"][brand].get("displayVersion", "")
    found = android_apks(ANDROID_ABI)
    if len(found) != 1:
        die(f"в {android_apk_dir()} ожидался один файл для {ANDROID_ABI}, найдено {len(found)}: "
            "сначала tools/build.py build")
    apk = found[0]
    problems = _apk_problems(apk) + _engine_sync_problems()
    release = is_release_env()
    if not release:
        warn("BROWSER_RELEASE не задана: пакет для разработки, файл в dist/ с суффиксом -dev")
    for problem in problems:
        warn(problem)
    if problems:
        die(f"приложение для Android не прошло проверку ({len(problems)}): в dist/ не кладётся")
    wanted = [loc for loc in config.get("locales", []) if loc != "en-US"]
    missing = [loc for loc in wanted if not _apk_has_engine_locale(apk, loc)]
    if missing:
        warn(f"служебные страницы движка останутся английскими: в файле нет перевода на {', '.join(missing)}")
    elif wanted:
        log(f"служебные страницы движка переведены: {', '.join(wanted)}")
    DIST.mkdir(exist_ok=True)
    name = f"tabora-{version}-android-{ANDROID_ABI}-unsigned.apk"
    if not release:
        name = _dev_name(name)
    shutil.copy(apk, DIST / name)
    digest = hashlib.sha256((DIST / name).read_bytes()).hexdigest()
    log(f"→ dist/{name} ({apk.stat().st_size >> 20} МБ, sha256 {digest})")


def android_apk_dir() -> Path:
    return objdir() / "gradle" / "build" / "mobile" / "android" / "fenix" / "app" / "outputs" / "apk"


def android_apks(abi: str = "") -> List[Path]:
    """Собранные файлы приложения нужного типа сборки (по одному на архитектуру процессора)."""
    return sorted(p for p in android_apk_dir().rglob("*.apk")
                  if f"-{ANDROID_BUILD_TYPE}" in p.name and (not abi or f"-{abi}-" in p.name))


def build_android(config: dict, brand: str) -> None:
    """Android: сначала движок (mach build собирает GeckoView и кладёт его в хранилище gradle
    внутри objdir), потом приложение. Приложение выходит неподписанным: подпись своим ключом —
    отдельный шаг вне сборки (tools/android/sign.sh), как у версии для компьютера."""
    version = config["brands"][brand].get("displayVersion", "")
    if not TABORA_VERSION_RE.match(version):
        die(f"displayVersion бренда {brand} должна быть вида X.Y.Z, сейчас {version!r}")
    rebrand_android_strings()
    log(f"полная сборка android/{target_arch()}, бренд «{brand}»: движок")
    mach(["build"], config, brand)
    android_multilocale(config, brand)
    log(f"сборка приложения Tabora {version} для Android")
    mach(["gradle", f"fenix:assemble{ANDROID_BUILD_TYPE.capitalize()}", f"-PversionName={version}",
          "-PdisableDebugSigning"], config, brand)
    apks = android_apks()
    if not apks:
        die(f"приложение не собрано: в {android_apk_dir()} нет файлов .apk")
    for apk in apks:
        log(f"собрано: {apk.relative_to(ENGINE)} ({apk.stat().st_size >> 20} МБ)")


def android_multilocale(config: dict, brand: str) -> None:
    """Перевод служебных страниц движка (страницы ошибок и т. п.) встраивается в omni.ja.
    Интерфейс самого приложения переведён отдельно, своими ресурсами. Если шаг не удался,
    сборка продолжается с английскими страницами движка: это заметно, но не мешает работе."""
    locales = [loc for loc in config.get("locales", []) if loc != "en-US"]
    if not locales:
        return
    fetch_l10n(config)
    try:
        mach(["package-multi-locale", "--locales", "en-US", *locales], config, brand)
    except subprocess.CalledProcessError as e:
        warn(f"перевод движка ({', '.join(locales)}) не встроен, код {e.returncode}: "
             "служебные страницы движка останутся английскими")
        return
    # gradle берёт omni.ja из dist/geckoview; переменная нужна, чтобы он не пересобрал его без перевода
    os.environ["MOZ_CHROME_MULTILOCALE"] = " ".join(["en-US", *locales])
    log(f"перевод движка встроен: {', '.join(locales)}")


def cmd_build(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    verify_mar_certs()
    if target_platform() == "android":
        if args.ui:
            die("--ui для Android не поддерживается: приложение собирается целиком")
        build_android(config, brand)
        return
    if args.ui:
        log("пересборка интерфейса (mach build faster)")
        mach(["build", "faster"], config, brand)
    else:
        log(f"полная сборка {target_platform()}/{target_arch()}, бренд «{brand}»")
        mach(["build"], config, brand)
    register_dev_locales(config)


def cmd_run(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    register_dev_locales(config)
    mach(["run", "--noprofile", *args.args], config, brand)


# ---------------------------------------------------------------------------
# Проверки сертификатов и упакованного приложения (используются и tools/release.py)

def verify_mar_certs(engine: bool = True) -> None:
    """Сертификаты MAR в src/ (и то, что видит движок) совпадают с закреплёнными отпечатками.
    engine=False — только src/: так проверяет import до того, как положит их в движок."""
    for name, expected in MAR_CERT_SHA256.items():
        path = MAR_CERTS_DIR / name
        if not path.is_file() or _sha256_bytes(path.read_bytes()) != expected:
            die(f"сертификат {path.relative_to(ROOT)} не совпадает с закреплённым в tools/build.py: "
                "подмена ключа обновлений?")
        engine_copy = ENGINE / "toolkit" / "mozapps" / "update" / "updater" / name
        if engine and engine_copy.exists() and _sha256_bytes(engine_copy.read_bytes()) != expected:
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


_PREF_LINE_RE = re.compile(
    r'^\s*pref\(\s*"([^"]+)"\s*,\s*(.*?)\s*(?:,\s*(?:sticky|locked)\s*)*\);\s*(?://.*)?$', re.M)


def _default_prefs(res: Path) -> Dict[str, str]:
    """Действующие значения настроек по умолчанию упакованного приложения (как текст из файла).
    Порядок чтения как у движка: greprefs.js, затем defaults/pref/*.js платформы, затем
    defaults/preferences/*.js приложения в обратном алфавитном порядке; позднее перекрывает."""
    import zipfile
    prefs: Dict[str, str] = {}
    for omni, prefix in ((res / "omni.ja", "defaults/pref/"), (res / "browser" / "omni.ja", "defaults/preferences/")):
        try:
            with zipfile.ZipFile(omni) as z:
                names = z.namelist()
                entries = ["greprefs.js"] if "greprefs.js" in names else []
                entries += sorted((n for n in names if n.startswith(prefix) and n.endswith(".js")), reverse=True)
                for entry in entries:
                    for m in _PREF_LINE_RE.finditer(z.read(entry).decode("utf-8", "replace")):
                        prefs[m.group(1)] = m.group(2)
        except (OSError, KeyError, zipfile.BadZipFile):
            continue
    return prefs


def _app_constants(res: Path) -> Dict[str, str]:
    """Константы сборки из modules/AppConstants.sys.mjs упакованного приложения:
    {"MOZILLA_OFFICIAL": "true", ...}; строки без кавычек."""
    import zipfile
    try:
        with zipfile.ZipFile(res / "omni.ja") as z:
            text = z.read("modules/AppConstants.sys.mjs").decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return {}
    out = {}
    # значение может стоять на следующей строке после служебных «//@line …» препроцессора
    for m in re.finditer(r'^\s*([A-Z][A-Z0-9_]*):\s*(?://[^\n]*\n\s*)*(true|false|"[^"\n]*")', text, re.M):
        out.setdefault(m.group(1), m.group(2).strip('"'))
    return out


def _application_ini(res: Path) -> str:
    try:
        return (res / "application.ini").read_text()
    except OSError:
        return ""


def _privacy_problems(app: Path, plat: str, config: dict, res: Path) -> List[str]:
    """То, чего не должно быть ни в какой сборке Tabora: отчёты о сбоях и телеметрия Mozilla,
    Team ID Mozilla, проверка загрузок в Google с ключом-заглушкой."""
    problems = []
    consts = _app_constants(res)
    if not consts:
        return ["не читается modules/AppConstants.sys.mjs из omni.ja"]
    for name in ("MOZ_CRASHREPORTER", "MOZ_TELEMETRY_REPORTING", "MOZ_DATA_REPORTING", "MOZ_NORMANDY"):
        if consts.get(name) != "false":
            problems.append(f"{name}={consts.get(name)} (должно быть false: configs/common/mozconfig, "
                            "src/browser/moz.configure.patch)")
    if consts.get("MOZ_REQUIRE_SIGNING") != "true":
        problems.append("MOZ_REQUIRE_SIGNING не включён: неподписанные дополнения будут ставиться")
    ini = _application_ini(res)
    if re.search(r"^\[Crash Reporter\]", ini, re.M) or "crash-reports.mozilla.com" in ini:
        problems.append("в application.ini есть [Crash Reporter] (нужен --disable-crashreporter)")
    bin_dir = app / "Contents" / "MacOS" if plat == "darwin" else app
    for name in ("crashreporter.app", "crashreporter", "crashhelper", "minidump-analyzer"):
        if (bin_dir / name).exists():
            problems.append(f"в пакете есть {name} (нужен --disable-crashreporter)")
    prefs = _default_prefs(res)
    has_key = consts.get("MOZ_GOOGLE_SAFEBROWSING_API_KEY", NO_SAFEBROWSING_KEY) not in ("", NO_SAFEBROWSING_KEY)
    remote = prefs.get("browser.safebrowsing.downloads.remote.enabled")
    if not has_key and remote != "false":
        problems.append("сборка без ключа Safe Browsing, но browser.safebrowsing.downloads.remote.enabled "
                        f"= {remote}: сведения о загрузках уйдут в Google")
    if has_key and remote != "true":
        problems.append("ключ Safe Browsing в сборке есть, а удалённая проверка загрузок выключена: "
                        "ключ появился после import/configure? Пересоберите")
    if plat == "darwin":
        team = mac_team_id(config).encode()
        plist = app / "Contents" / "Info.plist"
        data = plist.read_bytes() if plist.is_file() else b""
        if MOZILLA_TEAM_ID.encode() in data or team not in data:
            problems.append(f"в Info.plist требования подписи помощников не с Team ID {team.decode()} "
                            "(src/build/moz.configure/update-programs.configure.patch, macTeamId)")
        for path in sorted(p for p in app.rglob("org.mozilla.updater") if p.is_file()):
            data = path.read_bytes()
            if MOZILLA_TEAM_ID.encode() in data or team not in data:
                problems.append(f"в {path.relative_to(app)} зашит Team ID Mozilla или нет {team.decode()}")
    return problems


def _release_problems(res: Path) -> List[str]:
    """Признаки сборки для разработки в самом пакете (не зависят от репозитория)."""
    problems = []
    consts = _app_constants(res)
    if consts.get("MOZILLA_OFFICIAL") != "true":
        problems.append("MOZILLA_OFFICIAL не задан (сборка без BROWSER_RELEASE=1)")
    if consts.get("DEBUG") != "false":
        problems.append("отладочная сборка (DEBUG)")
    prefs = _default_prefs(res)
    for name in ("devtools.chrome.enabled", "devtools.debugger.remote-enabled"):
        if prefs.get(name) != "false":
            problems.append(f"{name} по умолчанию {prefs.get(name)}: отладка браузера и удалённая отладка включены")
    return problems


def _engine_sync_problems() -> List[str]:
    """engine/ соответствует src/: каждый патч наложен в нынешнем виде, файлы подключены."""
    problems = []
    if not (ENGINE / "mach").exists():
        return problems
    state = _load_applied()
    for path in sorted(SRC.rglob("*")):
        if not path.is_file() or path.name == ".gitkeep":
            continue
        rel = path.relative_to(SRC)
        if path.suffix == ".patch":
            entry = state.get(str(rel))
            if not entry or entry.get("sha256") != _sha256_bytes(path.read_bytes()):
                problems.append(f"патч src/{rel} не наложен в нынешнем виде (tools/build.py import)")
                continue
            for target, digest in (entry.get("files") or {}).items():
                if _engine_file_hash(target) != digest:
                    problems.append(f"engine/{target} изменён после наложения src/{rel}")
        else:
            target = ENGINE / rel
            if not (target.is_symlink() and os.readlink(target) == str(path)):
                problems.append(f"src/{rel} не подключён в engine/ (tools/build.py import)")
    return problems


def _source_problems(res: Path, config: dict) -> List[str]:
    """Пакет собран из текущего коммита без незакоммиченных правок во входных данных сборки."""
    problems = []
    head = git(["rev-parse", "HEAD"], cwd=ROOT, check=False)
    ini = _application_ini(res)
    stamp = re.search(r"^SourceStamp=(\S+)$", ini, re.M)
    if not re.match(r"^[0-9a-f]{40}$", head):
        problems.append("не удалось узнать коммит репозитория (git rev-parse HEAD)")
    elif not stamp or len(stamp.group(1)) < 7 or not head.startswith(stamp.group(1)):
        problems.append(f"SourceStamp пакета {stamp.group(1) if stamp else None!r} не совпадает с HEAD {head[:12]}: "
                        "после сборки были коммиты, пересоберите")
    repo = re.search(r"^SourceRepository=(\S*)$", ini, re.M)
    if not repo or repo.group(1) != config.get("repository", ""):
        problems.append("SourceRepository пакета не совпадает с repository из browser.json")
    dirty = run(["git", "status", "--porcelain", "--", "src", "configs", "tools", "browser.json",
                 "rust-toolchain.toml"], cwd=ROOT, check=False, capture=True)
    lines = [line for line in (dirty.stdout or "").splitlines() if line.strip()]
    if dirty.returncode != 0:
        problems.append("git status не выполнился")
    elif lines:
        shown = ", ".join(line[3:] for line in lines[:6]) + (" …" if len(lines) > 6 else "")
        problems.append(f"незакоммиченные правки во входных данных сборки ({len(lines)}): {shown}")
    problems += _engine_sync_problems()
    return problems


def verify_packaged_app(app: Path, plat: str, config: dict, allow_dev: bool = False,
                        check_source: bool = False) -> bool:
    """Упакованное приложение пригодно для выпуска: в обновляторе наши сертификаты MAR,
    принимаемый канал tabora-release, версия Tabora совпадает с browser.json, в
    application.ini нет адреса Mozilla, нет отчётов о сбоях и телеметрии, сборка релизная
    (MOZILLA_OFFICIAL, без удалённой отладки). Любое расхождение останавливает выпуск.

    check_source добавляет проверки по репозиторию: SourceStamp = HEAD, нет незакоммиченных
    правок, engine/ соответствует src/ (для локальной упаковки и подписи; в tools/release.py
    приложение может прийти архивом из другой рабочей копии).

    allow_dev: признаки сборки для разработки не останавливают, а печатаются; тогда функция
    возвращает False, и вызывающий обязан пометить результат как нераспространяемый.
    Возвращает True, если пакет релизный."""
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
    problems += _privacy_problems(app, plat, config, res)
    dev = _release_problems(res)
    if check_source:
        dev += _source_problems(res, config)
    if not allow_dev:
        problems += dev
    if problems:
        die("упакованное приложение не годится для выпуска:\n  " + "\n  ".join(problems))
    log("обновлятор: сертификаты Tabora, канал " + MAR_CHANNEL_ID + f", версия {want}; "
        "отчёты о сбоях и телеметрия выключены сборкой")
    if dev:
        warn("СБОРКА ДЛЯ РАЗРАБОТКИ, НЕ РАСПРОСТРАНЯТЬ:\n  " + "\n  ".join(dev))
        return False
    log("релизная конфигурация: MOZILLA_OFFICIAL, удалённая отладка выключена"
        + (", SourceStamp = HEAD, дерево чистое" if check_source else ""))
    return True


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
    if target_platform() == "android":
        package_android(config, brand)
        return
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
    # Без BROWSER_RELEASE пакет считается сборкой для разработки, даже если он выглядит релизным:
    # режим задаётся явно и одинаково для build и package.
    release = is_release_env()
    verify_packaged_app(app, target_platform(), config, allow_dev=not release, check_source=True)
    if not release:
        warn("BROWSER_RELEASE не задана: пакет для разработки, файлы в dist/ с суффиксом -dev. "
             "Для распространения: BROWSER_RELEASE=1 tools/build.py build && … package")
    DIST.mkdir(exist_ok=True)
    dist_dir = objdir() / "dist"
    copied = 0
    for pattern in ("*.dmg", "*.tar.xz", "*.tar.bz2", "*.zip", "*.exe", "*.msix"):
        for artifact in dist_dir.glob(pattern):
            name = artifact.name if release else _dev_name(artifact.name)
            shutil.copy(artifact, DIST / name)
            log(f"→ dist/{name}")
            copied += 1
            stale = DIST / artifact.name
            if not release and stale.exists():
                warn(f"в dist/ остался {artifact.name} под релизным именем от прежней упаковки: "
                     "проверьте, откуда он, и не распространяйте сборку для разработки")
    if not copied:
        warn(f"в {dist_dir} нет упакованных файлов")
    if args.app_tar:
        # приложение для tools/release.py в CI: tar сохраняет ссылки как ссылки
        name = f"tabora-app-{target_platform()}-{target_arch()}.tar"
        if not release:
            name = _dev_name(name)
        out = DIST / name
        run(["tar", "-cf", str(out), "-C", str(app.parent), app.name])
        log(f"→ dist/{name}")


def _dev_name(name: str) -> str:
    """tabora-1.0.mac.dmg → tabora-1.0.mac-dev.dmg; .tar.xz и .tar.bz2 считаются одним расширением."""
    for ext in (".tar.xz", ".tar.bz2"):
        if name.endswith(ext):
            return name[:-len(ext)] + "-dev" + ext
    stem, dot, ext = name.rpartition(".")
    return f"{stem}-dev.{ext}" if dot else name + "-dev"


def cmd_verify(args: argparse.Namespace) -> None:
    """Проверка упакованного приложения без упаковки (её вызывает tools/sign_macos.sh).
    Код возврата 0: пакет релизный, либо задан --dev и нарушены только признаки релиза."""
    config = load_config()
    plat = target_platform()
    app = Path(args.app).resolve() if args.app else packaged_app_path(plat)
    if not app.exists():
        die(f"нет {app}: сначала tools/build.py package")
    release = verify_packaged_app(app, plat, config, allow_dev=args.dev, check_source=True)
    print("release" if release else "dev")


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
    print(f"Режим:       {'релизный (BROWSER_RELEASE)' if is_release_env() else 'для разработки (без BROWSER_RELEASE, не распространять)'}; "
          f"ключ Safe Browsing {'есть' if safebrowsing_keyfile() else 'не найден'}")
    print(f"Объекты:     {objdir().relative_to(ROOT)}{'' if objdir().exists() else ' (ещё не собирали)'}")
    if (ENGINE / "mach").exists():
        changed = git(["status", "--short"]).splitlines()
        print(f"engine/:     изменённых файлов {len(changed)}")


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(prog="tools/build.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--brand", help="бренд из browser.json (по умолчанию из поля brand)")
    parser.add_argument("--no-gpg", action="store_true",
                        help="не проверять подпись SHA512SUMS Mozilla, если gpg не установлен (осознанный пропуск)")
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
    p = sub.add_parser("verify", help="проверить упакованное приложение (релизное ли оно)")
    p.add_argument("--dev", action="store_true", help="не считать ошибкой признаки сборки для разработки")
    p.add_argument("--app", help="путь к приложению (по умолчанию упакованное в objdir)")
    p.set_defaults(fn=cmd_verify)
    sub.add_parser("l10n", help="скачать переводы для locales из browser.json").set_defaults(fn=cmd_l10n)
    p = sub.add_parser("update", help="обновить версию Firefox в browser.json")
    p.add_argument("--to", help="конкретная версия, иначе последняя")
    p.set_defaults(fn=cmd_update)
    sub.add_parser("status", help="состояние проекта").set_defaults(fn=cmd_status)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
