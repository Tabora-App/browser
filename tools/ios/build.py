#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Сборка Tabora для iPhone.

На iPhone браузеру разрешён только движок системы (WebKit), поэтому основа — Firefox для iOS:
он целиком работает на WebKit. Его исходники в репозитории не хранятся: инструмент скачивает
закреплённый коммит в .build/ios/firefox-ios и накладывает наши изменения из src/ios/.

Команды:
  fetch            скачать исходники Firefox для iOS (коммит из browser.json, раздел ios)
  prepare          инструменты сборки: генератор настроек (закреплённый сценарий), скрипты страниц
  import           наложить изменения из src/ios на исходники
  export           превратить правки, сделанные прямо в исходниках, в патчи в src/ios
  reset            вернуть исходники к чистому Firefox для iOS
  build [--device] собрать приложение: для симулятора (по умолчанию) или для телефона
  run              поставить в симулятор и запустить
  shot <файл.png>  снимок экрана симулятора
  status           версия, коммит, что наложено

Нужны: Xcode (версия из README исходников), Node.js. Места на диске — около 12 ГБ.
Только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "browser.json").read_text())
IOS = CONFIG["ios"]
WORK = ROOT / ".build" / "ios"
TREE = WORK / "firefox-ios"
APP = TREE / "firefox-ios"
SRC = ROOT / "src" / "ios"
DERIVED = WORK / "DerivedData"
PACKAGES = WORK / "SourcePackages"
ADDED = TREE / ".tabora-added"  # файлы, которых нет в Firefox для iOS: их убирает reset
SIMULATOR = os.environ.get("TABORA_IOS_SIMULATOR", "iPhone 17")


def log(text: str) -> None:
    # вывод могут обрезать (… | head): это не должно прерывать работу на полпути — например,
    # import между наложением патчей и заменой названия в надписях
    try:
        print(f"\033[1;32m›\033[0m {text}", flush=True)
    except BrokenPipeError:
        sys.stdout = open(os.devnull, "w")


def die(text: str) -> None:
    print(f"\033[1;31m✗\033[0m {text}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list[str], cwd: Path | None = None, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, check=check, **kw)


def git(*args: str, capture: bool = False) -> str:
    r = run(["git", *args], cwd=TREE, capture_output=capture, text=True)
    return r.stdout if capture else ""


def need_tree() -> None:
    if not (TREE / ".git").is_dir():
        die("исходников нет: tools/ios/build.py fetch")
    head = git("rev-parse", "HEAD", capture=True).strip()
    if head != IOS["commit"]:
        die(f"в .build/ios/firefox-ios коммит {head[:12]}, в browser.json — {IOS['commit'][:12]}: tools/ios/build.py fetch")


# ---- исходники ---------------------------------------------------------------------------------

def cmd_fetch(args: argparse.Namespace) -> None:
    """Один коммит без истории: его хеш и есть проверка подлинности содержимого."""
    WORK.mkdir(parents=True, exist_ok=True)
    if not (TREE / ".git").is_dir():
        TREE.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q"], cwd=TREE)
        run(["git", "remote", "add", "origin", IOS["repository"]], cwd=TREE)
    head = run(["git", "rev-parse", "-q", "--verify", "HEAD"], cwd=TREE, check=False, capture_output=True, text=True).stdout.strip()
    if head == IOS["commit"]:
        log(f"исходники на месте: {IOS['tag']} ({head[:12]})")
        return
    log(f"скачиваю Firefox для iOS {IOS['tag']} ({IOS['commit'][:12]})")
    reset_tree()
    git("fetch", "-q", "--depth", "1", "origin", IOS["commit"])
    git("checkout", "-q", "FETCH_HEAD")
    if git("rev-parse", "HEAD", capture=True).strip() != IOS["commit"]:
        die("получен не тот коммит")
    log("готово: дальше prepare и import")


def reset_tree() -> None:
    if not (TREE / ".git").is_dir() or not run(["git", "rev-parse", "-q", "--verify", "HEAD"], cwd=TREE, check=False, capture_output=True).stdout:
        return
    git("checkout", "-q", "--", ".")
    if ADDED.exists():
        for rel in ADDED.read_text().splitlines():
            target = TREE / rel
            if rel and target.is_file():
                target.unlink()
        ADDED.unlink()


def automatic(rel: str) -> bool:
    """Правки, которые import делает сам (файл проекта, название в надписях): в патчи не выгружаются."""
    return rel.endswith((".strings", ".stringsdict", "project.pbxproj", "/Info.plist")) or rel == "firefox-ios/Shared/Strings.swift"


def unexported() -> list[str]:
    """Файлы исходников, правка которых не совпадает с патчем в src/ios: reset их потерял бы."""
    if not (TREE / ".git").is_dir() or not ADDED.exists():
        return []
    lost = []
    for rel in git("diff", "--name-only", capture=True).splitlines():
        if not rel or automatic(rel) or (SRC / rel).is_file():
            continue
        patch = SRC / (rel + ".patch")
        if not patch.is_file() or patch.read_text() != git("diff", "--", rel, capture=True):
            lost.append(rel)
    return lost


def guard_unexported(args: argparse.Namespace) -> None:
    lost = unexported()
    if lost and not getattr(args, "force", False):
        die("в исходниках есть правки, не выгруженные в src/ios (сначала export, или --force, чтобы их бросить):\n  " + "\n  ".join(lost[:12]))


def cmd_reset(args: argparse.Namespace) -> None:
    need_tree()
    guard_unexported(args)
    reset_tree()
    log("исходники возвращены к чистому Firefox для iOS")


# ---- наши изменения ----------------------------------------------------------------------------

def source_files() -> list[Path]:
    return sorted(p for p in SRC.rglob("*") if p.is_file() and p.name != ".DS_Store") if SRC.is_dir() else []


def cmd_import(args: argparse.Namespace) -> None:
    """src/ios повторяет пути исходников: «файл.patch» — правка существующего файла, остальное —
    файлы целиком (новые или заменяющие)."""
    need_tree()
    guard_unexported(args)
    reset_tree()
    patches, copied, added = 0, 0, []
    for path in source_files():
        rel = path.relative_to(SRC)
        if path.suffix == ".patch":
            r = run(["git", "apply", "--whitespace=nowarn", str(path)], cwd=TREE, check=False, capture_output=True, text=True)
            if r.returncode:
                die(f"патч не лёг: src/ios/{rel}\n{r.stderr.strip()[:600]}")
            patches += 1
        else:
            target = TREE / rel
            if not target.exists():
                added.append(str(rel))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            copied += 1
    ADDED.write_text("\n".join(added) + ("\n" if added else ""))
    log(f"src/ios: наложено патчей {patches}, положено файлов {copied}")
    project_edits()
    rebrand_strings()


# Расширения, которые в приложение не встраиваются: виджеты и стикеры нарисованы с логотипами
# Firefox, уведомления и подстановка паролей в чужие приложения работают через аккаунт Mozilla.
DROPPED_EXTENSIONS = ["WidgetKitExtension", "NotificationService", "CredentialProvider", "Sticker"]


def project_edits() -> None:
    """Правки файла проекта Xcode. Он огромный и меняется в каждом выпуске Firefox для iOS, поэтому
    вместо патча — замены по образцу, каждая с проверкой, что образец нашёлся."""
    pbx = APP / "Client.xcodeproj" / "project.pbxproj"
    text = pbx.read_text()

    def sub(pattern: str, to: str, what: str) -> None:
        nonlocal text
        text, count = re.subn(pattern, to, text)
        if not count:
            die(f"файл проекта: не найдено место для правки «{what}» — формат изменился")

    sub(r'TARGETED_DEVICE_FAMILY = "(?:1,2|iPhone, iPad)";', "TARGETED_DEVICE_FAMILY = 1;", "только iPhone")
    # запасные значки приложения — логотипы Firefox: в пакет не кладутся
    sub(r'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "[^"]*";', 'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "";', "запасные значки")
    sub(r"ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;", "ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = NO;", "запасные значки")
    for name in DROPPED_EXTENSIONS:
        sub(rf"\n\t+[0-9A-F]{{24}} /\* {name}\.appex in Embed App Extensions \*/,", "", f"расширение {name}")
    pbx.write_text(text)
    log(f"файл проекта: только iPhone, без запасных значков, без расширений {', '.join(DROPPED_EXTENSIONS)}")


def cmd_export(args: argparse.Namespace) -> None:
    """Правки текстовых файлов исходников → патчи. Файлы, которые лежат в src/ios целиком,
    обновляются копией."""
    need_tree()
    whole = {str(p.relative_to(SRC)) for p in source_files() if p.suffix != ".patch"}
    if whole and not ADDED.exists():
        die("в src/ios есть файлы, ещё не наложенные на исходники: сначала tools/ios/build.py import")
    changed = [line for line in git("diff", "--name-only", capture=True).splitlines() if line and not automatic(line)]
    patches, copies = 0, 0
    for rel in changed:
        if rel in whole:
            shutil.copy2(TREE / rel, SRC / rel)
            copies += 1
            continue
        numstat = git("diff", "--numstat", "--", rel, capture=True)
        if numstat.startswith("-\t-"):
            die(f"двоичный файл изменён: {rel} — положите его в src/ios целиком")
        diff = git("diff", "--", rel, capture=True)
        out = SRC / (rel + ".patch")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(diff)
        patches += 1
    stale = [p for p in source_files() if p.suffix == ".patch" and str(p.relative_to(SRC))[:-6] not in changed]
    for p in stale:
        p.unlink()
    # новые файлы (их нет в Firefox для iOS) git diff не показывает: они известны по списку, который
    # ведёт import. Без import файлы из src/ios в исходниках ещё не лежат — их не трогаем.
    added = set(ADDED.read_text().splitlines()) if ADDED.exists() else set()
    for rel in sorted(whole & added):
        if (TREE / rel).is_file() and (TREE / rel).read_bytes() != (SRC / rel).read_bytes():
            shutil.copy2(TREE / rel, SRC / rel)
            copies += 1
    log(f"src/ios: патчей {patches}, обновлено файлов {copies}, убрано устаревших патчей {len(stale)}")


# Название в надписях. Имя приложения в коде — AppName (патч в src/ios), но в переводах сотни
# надписей, где переводчики написали «Firefox» буквально, на сотне языков: править их патчами
# нельзя, поэтому замена идёт по месту при каждом import, и только в тексте надписи, не в ключе.
STRINGS_LINE = re.compile(r'^(\s*(?:"(?:[^"\\]|\\.)*"|[\w.-]+)\s*=\s*")((?:[^"\\]|\\.)*)(".*)$')
SWIFT_VALUE = re.compile(r'(\bvalue:\s*")((?:[^"\\]|\\.)*)(")')
STRING_ROOTS = ["firefox-ios/Shared", "firefox-ios/Client", "firefox-ios/Extensions", "firefox-ios/WidgetKit", "BrowserKit/Sources"]


def rebrand_strings() -> None:
    files = values = 0
    for root in STRING_ROOTS:
        for path in sorted((TREE / root).rglob("*.strings")) + sorted((TREE / root).rglob("*.stringsdict")):
            raw = path.read_bytes()
            # часть старых файлов переводов записана в UTF-16: кодировка файла сохраняется
            encoding = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8"
            text = raw.decode(encoding)
            if "Firefox" not in text:
                continue
            out, changed = [], 0
            for line in text.split("\n"):
                if path.suffix == ".strings":
                    m = STRINGS_LINE.match(line)
                    if m and "Firefox" in m.group(2):
                        line = m.group(1) + m.group(2).replace("Firefox", "Tabora") + m.group(3)
                        changed += 1
                elif "<string>" in line and "Firefox" in line:
                    line = line.replace("Firefox", "Tabora")
                    changed += 1
                out.append(line)
            if changed:
                path.write_bytes("\n".join(out).encode(encoding))
                files += 1
                values += changed
    # описания приложения и расширений: тексты системных запросов доступа и название действия
    # «Открыть в …» (имена картинок вроде logoFirefoxLarge — не надписи, их не трогаем)
    plists = [TREE / "firefox-ios" / "Client" / "Info.plist", *sorted((TREE / "firefox-ios" / "Extensions").glob("*/Info.plist"))]
    for path in plists:
        text = path.read_text(encoding="utf-8")
        out = [line.replace("Firefox", "Tabora") if "<string>" in line and " " in line.strip() and "Firefox" in line else line for line in text.split("\n")]
        if out != text.split("\n"):
            path.write_text("\n".join(out), encoding="utf-8")
            files += 1
    # английские надписи записаны в коде как значения по умолчанию
    code = TREE / "firefox-ios" / "Shared" / "Strings.swift"
    text, count = SWIFT_VALUE.subn(lambda m: m.group(1) + m.group(2).replace("Firefox", "Tabora") + m.group(3) if "Firefox" in m.group(2) else m.group(0), code.read_text(encoding="utf-8"))
    code.write_text(text, encoding="utf-8")
    log(f"название в надписях: файлов переводов {files}, надписей {values}; Strings.swift обновлён")


# ---- инструменты сборки ------------------------------------------------------------------------

def cmd_prepare(args: argparse.Namespace) -> None:
    """То же, что bootstrap.sh исходников, но без «скачать последнее из сети и выполнить»:
    сценарий генератора настроек берётся из закреплённого коммита и сверяется по SHA-256,
    зависимости скриптов страниц ставятся строго по package-lock.json и без install-скриптов."""
    need_tree()
    nimbus = IOS["nimbus"]
    target = APP / "bin" / "nimbus-fml.sh"
    url = f"https://raw.githubusercontent.com/mozilla/application-services/{nimbus['commit']}/components/nimbus/ios/scripts/nimbus-fml.sh"
    data = urllib.request.urlopen(url, timeout=60).read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != nimbus["sha256"]:
        die(f"nimbus-fml.sh: SHA-256 {digest}, ожидался {nimbus['sha256']}")
    target.write_bytes(data)
    target.chmod(0o755)
    log("генератор настроек: сценарий на месте и сверен")
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=TREE, stdout=subprocess.DEVNULL)
    run(["npm", "run", "build"], cwd=TREE, stdout=subprocess.DEVNULL)
    log("скрипты страниц собраны")


# ---- сборка и запуск ---------------------------------------------------------------------------

def products(device: bool) -> Path:
    return DERIVED / "Build" / "Products" / ("Firefox-iphoneos" if device else "Debug-iphonesimulator") / "Client.app"


def cmd_build(args: argparse.Namespace) -> None:
    need_tree()
    WORK.mkdir(parents=True, exist_ok=True)
    out = WORK / ("build-device.log" if args.device else "build-sim.log")
    cmd = [
        "xcodebuild", "-project", str(APP / "Client.xcodeproj"), "-scheme", "Fennec",
        "-derivedDataPath", str(DERIVED),
        # пакеты лежат отдельно от объектных файлов (4,6 ГБ: не скачивать заново после очистки сборки)
        # и берутся строго тех версий, что записаны в Package.resolved
        "-clonedSourcePackagesDirPath", str(PACKAGES), "-onlyUsePackageVersionsFromResolvedFile",
        # макрос и подключаемые модули пакетов Xcode просит одобрить в окне; в сборке из командной
        # строки окна нет — пакеты закреплены в Package.resolved
        "-skipMacroValidation", "-skipPackagePluginValidation",
    ]
    if args.device:
        cmd += ["-configuration", "Firefox", "-destination", "generic/platform=iOS", "CODE_SIGNING_ALLOWED=NO"]
    else:
        # конфигурация Debug проекта — это сборка «Fennec» для разработки (Client/Configuration/Fennec.xcconfig)
        # Подпись не отключается: для симулятора Xcode подписывает сам, без профилей, и только так
        # приложение получает свои права — общее хранилище группы и связку ключей. Без них оно
        # запускается, но не сохраняет вкладки и работает без части настроек.
        cmd += ["-configuration", "Debug", "-destination", f"platform=iOS Simulator,name={SIMULATOR}"]
    cmd += ["build"]
    log(f"сборка ({'телефон' if args.device else 'симулятор'}): журнал {out.relative_to(ROOT)}")
    with out.open("w") as f:
        r = run(cmd, cwd=APP, check=False, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode:
        errors = [line for line in out.read_text(errors="replace").splitlines() if " error: " in line or line.startswith("error:")]
        print("\n".join(dict.fromkeys(errors[:25])))
        die(f"сборка не прошла, код {r.returncode}")
    log(f"собрано: {products(args.device).relative_to(ROOT)}")


def simctl(*args: str, check: bool = True, capture: bool = False) -> str:
    r = run(["xcrun", "simctl", *args], check=check, capture_output=capture, text=True)
    return r.stdout if capture else ""


def bundle_id(app: Path) -> str:
    return run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", str(app / "Info.plist")], capture_output=True, text=True).stdout.strip()


def cmd_run(args: argparse.Namespace) -> None:
    app = products(False)
    if not app.is_dir():
        die("приложение не собрано: tools/ios/build.py build")
    simctl("boot", SIMULATOR, check=False, capture=True)
    simctl("bootstatus", SIMULATOR, capture=True)
    simctl("install", SIMULATOR, str(app))
    simctl("launch", SIMULATOR, bundle_id(app), *args.args, capture=True)
    log(f"запущено в симуляторе «{SIMULATOR}»: {bundle_id(app)}")


def cmd_shot(args: argparse.Namespace) -> None:
    simctl("io", SIMULATOR, "screenshot", args.file, capture=True)
    log(f"снимок: {args.file}")


def cmd_status(args: argparse.Namespace) -> None:
    print(f"Firefox для iOS: {IOS['tag']} ({IOS['commit'][:12]})")
    print(f"исходники: {'есть' if (TREE / '.git').is_dir() else 'нет'} — {TREE.relative_to(ROOT)}")
    files = source_files()
    print(f"src/ios: патчей {sum(p.suffix == '.patch' for p in files)}, файлов {sum(p.suffix != '.patch' for p in files)}")
    for device in (False, True):
        app = products(device)
        if app.is_dir():
            print(f"собрано ({'телефон' if device else 'симулятор'}): {bundle_id(app)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Сборка Tabora для iPhone")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, fn in [("fetch", cmd_fetch), ("prepare", cmd_prepare), ("export", cmd_export), ("status", cmd_status)]:
        sub.add_parser(name).set_defaults(fn=fn)
    for name, fn in [("import", cmd_import), ("reset", cmd_reset)]:
        p = sub.add_parser(name)
        p.add_argument("--force", action="store_true", help="бросить правки исходников, не выгруженные в src/ios")
        p.set_defaults(fn=fn)
    p = sub.add_parser("build")
    p.add_argument("--device", action="store_true")
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser("run")
    p.add_argument("args", nargs="*")
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("shot")
    p.add_argument("file")
    p.set_defaults(fn=cmd_shot)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
