#!/usr/bin/env python3
"""Выпуск обновления Tabora.

Из упакованного приложения (dist/Tabora.app после `build.py package`) собирает полный
MAR-пакет, подписывает его ключом Tabora, считает sha512 и размер, пишет манифесты
`updates/channel.json` и `updates/<канал>/<цель>/update.xml` и, при --publish, создаёт
релиз на GitHub с пакетом и dmg. Пуш манифестов в main делается отдельно (git), чтобы
клиенты увидели обновление только после загрузки пакета.

Примеры:
  python3 tools/release.py mar                      # только собрать и подписать MAR
  python3 tools/release.py manifest --minimum 0.1.0 # обновить updates/ под текущую версию
  python3 tools/release.py publish --minimum 0.1.0 --notes "Что нового…"
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "engine"
BUILD = ROOT / ".build"
KEYS = BUILD / "mar-keys"
UPDATES = ROOT / "updates"


def cfg():
    return json.loads((ROOT / "browser.json").read_text())


def objdir():
    plat = os.environ.get("TARGET_PLATFORM", "darwin")
    arch = os.environ.get("TARGET_ARCH", "aarch64")
    return ENGINE / f"obj-{plat}-{arch}", plat, arch


def build_target(plat, arch):
    if plat == "darwin":
        return f"Darwin_{arch}-gcc3"
    if plat == "linux":
        return f"Linux_{'x86_64' if arch == 'x86_64' else arch}-gcc3"
    return f"WINNT_{arch}-msvc"


def sh(cmd, env=None, cwd=None):
    print("›", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, env=env, cwd=cwd)


def version(config):
    brand = config["brands"][config["brand"]]
    return brand["displayVersion"], config["firefox"]["version"]


def find_app(obj):
    for p in [obj / "dist" / "Tabora.app", obj / "dist" / "tabora" / "Tabora.app"]:
        if p.exists():
            return p
    raise SystemExit("нет упакованного приложения: сначала `python3 tools/build.py package`")


def build_id(app):
    ini = app / "Contents" / "Resources" / "application.ini"
    for line in ini.read_text().splitlines():
        if line.startswith("BuildID="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("в application.ini нет BuildID")


def make_mar(args):
    config = cfg()
    obj, plat, arch = objdir()
    disp, app_ver = version(config)
    app = find_app(obj)
    out_dir = BUILD / "release"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"tabora-{disp}-{plat}-{arch}.complete.mar"
    unsigned = out_dir / f"{name}.unsigned"
    signed = out_dir / name
    env = dict(os.environ)
    env.update({
        "MAR": str(obj / "dist" / "host" / "bin" / "mar"),
        "MBSDIFF": str(obj / "dist" / "host" / "bin" / "mbsdiff"),
        "MOZ_PRODUCT_VERSION": app_ver,
        "MAR_CHANNEL_ID": os.environ.get("MAR_CHANNEL_ID", "tabora-release"),
    })
    for p in (unsigned, signed):
        if p.exists():
            p.unlink()
    # копия приложения с файлом precomplete (его создаёт упаковщик; в сборке для разработки его нет)
    stage = out_dir / "stage" / app.name
    if stage.exists():
        shutil.rmtree(stage)
    stage.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(app, stage, symlinks=False)
    sys.path.insert(0, str(ENGINE / "config"))
    from createprecomplete import generate_precomplete  # noqa: E402

    generate_precomplete(str(stage / "Contents" / "Resources") if plat == "darwin" else str(stage))
    sh(["bash", ENGINE / "tools" / "update-packaging" / "make_full_update.sh", unsigned, stage], env=env)
    if not KEYS.exists():
        raise SystemExit(f"нет ключей подписи в {KEYS}: создайте certutil-ом (см. updates/README.md)")
    signmar = obj / "dist" / "bin" / "signmar"
    env2 = dict(os.environ, DYLD_LIBRARY_PATH=str(obj / "dist" / "bin"), LD_LIBRARY_PATH=str(obj / "dist" / "bin"))
    sh([signmar, "-d", f"sql:{KEYS}", "-n", args.cert, "-s", unsigned, signed], env=env2)
    sh([signmar, "-d", f"sql:{KEYS}", "-n", args.cert, "-v", signed], env=env2)
    unsigned.unlink()
    size = signed.stat().st_size
    sha = hashlib.sha512(signed.read_bytes()).hexdigest()
    meta = {"file": str(signed), "name": name, "size": size, "sha512": sha, "version": disp, "appVersion": app_ver, "buildID": build_id(stage), "target": build_target(plat, arch)}
    shutil.rmtree(stage, ignore_errors=True)
    (out_dir / f"{name}.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2, ensure_ascii=False))
    return meta


def write_manifests(args, meta):
    config = cfg()
    brand = config["brands"][config["brand"]]
    repo = config["repository"].rstrip("/")
    tag = f"v{meta['version']}"
    mar_url = f"{repo}/releases/download/{tag}/{meta['name']}"
    channel = os.environ.get("MOZ_UPDATE_CHANNEL", "release")
    target_dir = UPDATES / channel / meta["target"]
    target_dir.mkdir(parents=True, exist_ok=True)
    details = brand.get("urls", {}).get("releaseNotes") or f"{repo}/releases/tag/{tag}"
    xml = (
        '<?xml version="1.0"?>\n<updates>\n'
        f'  <update type="minor" displayVersion="{meta["version"]}" appVersion="{meta["appVersion"]}" '
        f'buildID="{meta["buildID"]}" detailsURL="{details}">\n'
        f'    <patch type="complete" URL="{mar_url}" hashFunction="sha512" hashValue="{meta["sha512"]}" size="{meta["size"]}"/>\n'
        "  </update>\n</updates>\n"
    )
    (target_dir / "update.xml").write_text(xml)
    ch_path = UPDATES / "channel.json"
    data = json.loads(ch_path.read_text()) if ch_path.exists() else {}
    entry = data.get(channel, {})
    entry.update({
        "version": meta["version"],
        "minimum": args.minimum or entry.get("minimum") or meta["version"],
        "notes": args.notes if args.notes is not None else entry.get("notes", ""),
        "notesUrl": details,
        "published": date.today().isoformat(),
    })
    data[channel] = entry
    ch_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"манифесты: {target_dir / 'update.xml'}, {ch_path}")
    return tag, mar_url


def publish(args):
    meta = make_mar(args)
    tag, _ = write_manifests(args, meta)
    obj, _, _ = objdir()
    assets = [meta["file"]]
    for dmg in (obj / "dist").glob("*.dmg"):
        assets.append(str(dmg))
    notes = args.notes or f"Tabora {meta['version']}"
    exists = subprocess.run(["gh", "release", "view", tag], capture_output=True).returncode == 0
    if exists:
        sh(["gh", "release", "upload", tag, *assets, "--clobber"])
    else:
        sh(["gh", "release", "create", tag, *assets, "--title", f"Tabora {meta['version']}", "--notes", notes])
    print("Готово. Теперь закоммитьте и запушьте папку updates/, чтобы клиенты увидели обновление:")
    print(f"  git add updates && git commit -m 'Обновление {meta['version']}' && git push")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("mar", "manifest", "publish"):
        p = sub.add_parser(name)
        p.add_argument("--cert", default="tabora-mar-primary", help="имя сертификата в .build/mar-keys")
        p.add_argument("--minimum", help="минимально допустимая версия (ниже — обновление обязательное)")
        p.add_argument("--notes", help="что нового")
    args = ap.parse_args()
    if args.cmd == "mar":
        make_mar(args)
    elif args.cmd == "manifest":
        meta_files = sorted((BUILD / "release").glob("*.complete.mar.json"))
        if not meta_files:
            raise SystemExit("сначала соберите MAR: tools/release.py mar")
        write_manifests(args, json.loads(meta_files[-1].read_text()))
    else:
        publish(args)


if __name__ == "__main__":
    main()
