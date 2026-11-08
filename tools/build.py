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
  package         упаковать сборку в dist/
  update [--to V] обновить версию Firefox в browser.json (по умолчанию до последней)
  status          показать версию, бренд и платформу

Переменные окружения:
  TARGET_PLATFORM  darwin | linux (по умолчанию хост)
  TARGET_ARCH      aarch64 | x86_64 (по умолчанию хост)
  BROWSER_RELEASE  1 = релизная сборка (оптимизации, без тестов)
  BROWSER_DISABLE_LTO, BROWSER_DISABLE_BOOTSTRAP  см. configs/common/mozconfig

Только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
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

ARCHIVE = "https://archive.mozilla.org/pub/firefox/releases/{v}/source/firefox-{v}.source.tar.xz"
PRODUCT_DETAILS = "https://product-details.mozilla.org/1.0/firefox_versions.json"
ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256]


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

def cmd_download(args: argparse.Namespace) -> None:
    config = load_config()
    version = config["firefox"]["version"]
    if (ENGINE / "mach").exists() and not args.force:
        current = (BUILD_STATE / "engine-version").read_text().strip() if (BUILD_STATE / "engine-version").exists() else "?"
        if current == version:
            log(f"исходники Firefox {version} уже на месте")
            return
        warn(f"в engine/ лежит Firefox {current}, нужна {version}: перекачиваю")
    if ENGINE.exists():
        shutil.rmtree(ENGINE)
    BUILD_STATE.mkdir(exist_ok=True)
    archive = BUILD_STATE / f"firefox-{version}.source.tar.xz"
    if not archive.exists():
        url = ARCHIVE.format(v=version)
        log(f"скачиваю {url}")
        _download(url, archive)
    else:
        log(f"архив уже скачан: {archive.name}")
    log("распаковываю (несколько минут)")
    with tempfile.TemporaryDirectory(dir=str(ROOT)) as tmp:
        tar = shutil.which("gtar") or "tar"
        run([tar, "-xf", str(archive), "-C", tmp])
        extracted = next(Path(tmp).iterdir())
        shutil.move(str(extracted), str(ENGINE))
    log("инициализирую git в engine/, чтобы отслеживать наши изменения")
    git(["init", "-q"])
    git(["config", "user.name", "build"])
    git(["config", "user.email", "build@localhost"])
    git(["config", "core.autocrlf", "false"])
    git(["add", "-A"])
    git(["commit", "-qm", f"Firefox {version}"])
    (BUILD_STATE / "engine-version").write_text(version + "\n")
    log(f"готово: Firefox {version} в engine/")


def _download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} МБ", end="", flush=True)
    print()
    tmp.rename(dest)


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
        with urllib.request.urlopen(PRODUCT_DETAILS) as resp:
            latest = json.load(resp)["LATEST_FIREFOX_VERSION"]
    current = config["firefox"]["version"]
    if latest == current:
        log(f"уже последняя версия: {current}")
        return
    config["firefox"]["version"] = latest
    save_config(config)
    log(f"Firefox {current} → {latest}; дальше: download, import, build")


# ---------------------------------------------------------------------------
# import: брендинг + изменения из src/

def cmd_import(args: argparse.Namespace) -> None:
    need_engine()
    config = load_config()
    brand = brand_name(config, args.brand)
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
        f"MOZ_APP_VENDOR={names['vendor']}\n"
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
        + 'pref("devtools.selfxss.count", 5);\n'
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


def apply_src() -> None:
    """src/ зеркалит дерево Firefox: *.patch накладываются git apply,
    остальные файлы подключаются символическими ссылками, чтобы правки в src/
    сразу попадали в сборку."""
    BUILD_STATE.mkdir(exist_ok=True)
    applied_file = BUILD_STATE / "applied.json"
    applied = set(json.loads(applied_file.read_text())) if applied_file.exists() else set()
    patches, files = 0, 0
    for path in sorted(SRC.rglob("*")):
        if not path.is_file() or path.name == ".gitkeep":
            continue
        rel = path.relative_to(SRC)
        if path.suffix == ".patch":
            key = str(rel)
            if key in applied:
                continue
            check = run(["git", "apply", "--check", str(path)], cwd=ENGINE, check=False, capture=True)
            if check.returncode != 0:
                reverse = run(["git", "apply", "--check", "-R", str(path)], cwd=ENGINE, check=False, capture=True)
                if reverse.returncode == 0:
                    applied.add(key)
                    continue
                die(f"патч {rel} не накладывается:\n{check.stderr}")
            run(["git", "apply", str(path)], cwd=ENGINE)
            applied.add(key)
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
    applied_file.write_text(json.dumps(sorted(applied), indent=2))
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
        diff = git(["diff", "--", rel])
        if not diff.strip():
            continue
        target = SRC / (rel + ".patch")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(diff + "\n")
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
    update_host = config.get("updateHost") or "localhost:7648 # заглушка, сервера обновлений пока нет"
    header = f"""# Сгенерировано tools/build.py, не редактировать: правьте configs/*/mozconfig
mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-{plat}-{target_arch()}

ac_add_options --with-app-name={config['binaryName']}
ac_add_options --with-app-basename={app_basename}
ac_add_options --with-branding=browser/branding/{brand}
ac_add_options --with-distribution-id={config['appId']}
ac_add_options --enable-update-channel={brand}
ac_add_options --target={target_triple()}

export MOZ_APPUPDATE_HOST={update_host}
export MOZ_SOURCE_REPO={config.get('repository', '')}
export MOZ_SOURCE_CHANGESET={changeset}
export MOZ_INCLUDE_SOURCE_INFO=1
export BROWSER_DISPLAY_VERSION={info.get('displayVersion', '0.0.0')}
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


def cmd_package(args: argparse.Namespace) -> None:
    config = load_config()
    brand = brand_name(config, args.brand)
    mach(["package"], config, brand)
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
    sub.add_parser("package", help="упаковать в dist/").set_defaults(fn=cmd_package)
    p = sub.add_parser("update", help="обновить версию Firefox в browser.json")
    p.add_argument("--to", help="конкретная версия, иначе последняя")
    p.set_defaults(fn=cmd_update)
    sub.add_parser("status", help="состояние проекта").set_defaults(fn=cmd_status)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
