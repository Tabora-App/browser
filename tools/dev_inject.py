#!/usr/bin/env python3
"""Быстрая проверка оболочки без пересборки: вшивает файлы из src/ и брендинг
в omni.ja уже собранного приложения и запускает его с чистым профилем.

  tools/dev_inject.py [--app .build/Tabora.app] [--no-run]

Нужна резервная копия .build/omni.ja.bak исходного архива (делается автоматически
при первом запуске). Для настоящей сборки используйте tools/build.py.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "browser" / "base" / "content" / "tabora"
BRANDING = ROOT / "configs" / "branding" / "release"
ENGINE = ROOT / "engine"

EXTRA_PREFS = """
pref("devtools.console.stdout.chrome", true);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("messaging-system.rsexperimentloader.enabled", false);
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "null");
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "null");
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "null");
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=str(ROOT / ".build" / "Tabora.app"))
    ap.add_argument("--no-run", action="store_true")
    args = ap.parse_args()
    app = Path(args.app) / "Contents" / "Resources"
    omni = app / "browser" / "omni.ja"
    backup = ROOT / ".build" / "omni.ja.bak"
    if not backup.exists():
        shutil.copy(omni, backup)
    shutil.copy(backup, omni)

    subprocess.run(["pkill", "-f", "Tabora.app/Contents/MacOS/tabora"], check=False)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        with zipfile.ZipFile(backup) as z:
            z.extract("chrome/browser/content/browser/browser.xhtml", tmp)
            z.extract("chrome/browser/content/browser/sidebar/sidebar-main.css", tmp)
        x = tmp / "chrome/browser/content/browser/browser.xhtml"
        s = x.read_text()
        s = s.replace(
            '<script src="chrome://browser/content/browser-main.js"></script>',
            '<link rel="stylesheet" href="chrome://browser/content/tabora/tabora.css" />\n'
            '  <script src="chrome://browser/content/browser-main.js"></script>\n'
            '  <script src="chrome://browser/content/tabora/tabora.js"></script>',
            1,
        )
        x.write_text(s)
        c = tmp / "chrome/browser/content/browser/sidebar/sidebar-main.css"
        c.write_text(c.read_text() + "\n.bottom-actions,\n.buttons-wrapper,\n#sidebar-tools-and-extensions-splitter { display: none !important; }\n")

        dest = tmp / "chrome/browser/content/browser/tabora"
        (dest / "fonts").mkdir(parents=True)
        for f in SRC.iterdir():
            if f.is_file():
                shutil.copy(f, dest / f.name)
        for f in (SRC / "fonts").iterdir():
            shutil.copy(f, dest / "fonts" / f.name)
        b = tmp / "chrome/browser/content/branding"
        b.mkdir(parents=True)
        for name in ("about-wordmark.svg", "aboutDialog.css"):
            shutil.copy(BRANDING / "content" / name, b / name)

        prefs = tmp / "defaults/preferences"
        prefs.mkdir(parents=True)
        branding_prefs = ENGINE / "browser/branding/release/pref/firefox-branding.js"
        (prefs / "00-tabora.js").write_text(branding_prefs.read_text() + EXTRA_PREFS)

        subprocess.run(["zip", "-q", "-X", "-0", "-r", str(omni), "chrome", "defaults"], cwd=tmp, check=True)
    print("omni.ja обновлён")

    if args.no_run:
        return
    profile = ROOT / ".build" / "profile-test"
    shutil.rmtree(profile, ignore_errors=True)
    profile.mkdir(parents=True)
    log = open(ROOT / ".build" / "run.log", "w")
    subprocess.Popen(
        [str(Path(args.app) / "Contents/MacOS/tabora"), "--profile", str(profile), "-purgecaches"],
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    print("запущено с чистым профилем, лог в .build/run.log")


if __name__ == "__main__":
    main()
