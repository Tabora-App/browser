#!/usr/bin/env python3
"""Выпуск обновления Tabora.

Из упакованного приложения (после `tools/build.py package`: engine/obj-*/dist/tabora/Tabora.app
или каталог tabora/ на Linux, либо --app-tar из артефакта CI) собирает полный MAR-пакет,
подписывает его ключом Tabora, пишет подписанный манифест цели
`updates/<канал>/<цель>/manifest.json`, `updates/<канал>/<цель>/update.xml` и общий
`updates/channel.json` (для старых сборок) и, при publish, создаёт релиз на GitHub с пакетом
и dmg. Пуш манифестов в main делается отдельно (git): клиенты увидят обновление только после
загрузки пакета.

Перед сборкой MAR проверяется, что в упакованном обновляторе наши сертификаты и канал
tabora-release, версия Tabora в приложении совпадает с browser.json и выше уже выпущенной.
Уже лежащий в updates/ манифест используется (версия, minimum, заметки, время подписи),
только если его подпись проверена ключами MANIFEST_KEYS; иначе выпуск останавливается.

Ключи лежат вне репозитория (docs/UPDATES.md):
  TABORA_MAR_KEYS_DIR            основная NSS-база (по умолчанию ~/.config/tabora/mar-keys)
                                 + manifest-ed25519.pem — ключ подписи манифестов
  TABORA_MAR_SECONDARY_KEYS_DIR  запасная база (по умолчанию ~/.config/tabora/mar-keys-secondary),
                                 нужна только с --key secondary
  TABORA_MAR_KEYS_PASSWORD_FILE  файл с паролем NSS-базы и PEM (если пароль задан);
                                 без него signmar спросит пароль в терминале

Примеры:
  python3 tools/release.py check                      # только проверить упакованное приложение
  python3 tools/release.py mar                        # собрать и подписать MAR
  python3 tools/release.py manifest --minimum 0.1.0   # манифесты по последнему MAR этой цели
                                                      # (без --minimum обязательности нет)
  python3 tools/release.py publish --minimum 0.1.0 --notes "Что нового…"
  python3 tools/release.py refresh                    # продлить срок манифестов без выпуска
  python3 tools/release.py tools --out DIR            # (CI) signmar из проверенных исходников
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "engine"
BUILD = ROOT / ".build"
UPDATES = ROOT / "updates"
RELEASE_DIR = BUILD / "release"

sys.path.insert(0, str(ROOT / "tools"))
import build as buildtool  # noqa: E402

CONFIG_DIR = Path.home() / ".config" / "tabora"
CERT_NAMES = {"primary": "tabora-mar-primary", "secondary": "tabora-mar-secondary"}
MANIFEST_KEY_FILE = "manifest-ed25519.pem"
MANIFEST_FORMAT = 1
DEFAULT_VALID_DAYS = 90
VERSION_RE = buildtool.TABORA_VERSION_RE
# Имена файлов внутри приложения: make_full_update.sh подставляет их в eval, поэтому
# кавычки, $, обратные кавычки и обратная косая черта недопустимы.
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9 ._+@,()\[\]{}~#%=&!'-]+$")


def cfg() -> dict:
    return json.loads((ROOT / "browser.json").read_text())


def die(msg: str) -> None:
    raise SystemExit(f"✗ {msg}")


def vtuple(v: str) -> Tuple[int, ...]:
    if not isinstance(v, str) or not VERSION_RE.match(v):
        die(f"неверная версия: {v!r} (нужно X.Y.Z)")
    return tuple(int(x) for x in v.split("."))


def target_env() -> Tuple[str, str]:
    plat = os.environ.get("TARGET_PLATFORM") or buildtool.host_platform()
    arch = os.environ.get("TARGET_ARCH") or buildtool.host_arch()
    if plat not in ("darwin", "linux") or arch not in ("aarch64", "x86_64"):
        die(f"неизвестная цель {plat}/{arch}")
    return plat, arch


def objdir(plat: str, arch: str) -> Path:
    return ENGINE / f"obj-{plat}-{arch}"


def build_target(plat: str, arch: str) -> str:
    # совпадает с %BUILD_TARGET% движка: Services.appinfo.OS + "_" + UpdateUtils.ABI
    if plat == "darwin":
        return f"Darwin_{arch}-gcc3"
    return f"Linux_{arch}-gcc3"


def channel_name() -> str:
    name = os.environ.get("MOZ_UPDATE_CHANNEL") or cfg().get("brand", "release")
    if not re.match(r"^[a-z][a-z0-9-]{0,31}$", name):
        die(f"неверное имя канала: {name!r}")
    return name


def tabora_version(config: dict) -> Tuple[str, str]:
    brand = config["brands"][config["brand"]]
    disp = brand["displayVersion"]
    vtuple(disp)
    return disp, config["firefox"]["version"]


def sh(cmd: List, env: Optional[dict] = None, cwd: Optional[Path] = None, stdin=None,
       capture: bool = False) -> subprocess.CompletedProcess:
    print("›", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, env=env, cwd=cwd, stdin=stdin,
                          text=True, capture_output=capture)


# ---------------------------------------------------------------------------
# Ключи

def keys_dir(which: str) -> Path:
    if which == "secondary":
        path = os.environ.get("TABORA_MAR_SECONDARY_KEYS_DIR") or str(CONFIG_DIR / "mar-keys-secondary")
    else:
        path = os.environ.get("TABORA_MAR_KEYS_DIR") or str(CONFIG_DIR / "mar-keys")
    p = Path(path).expanduser().resolve()
    if p == ROOT or ROOT in p.parents:
        die(f"база ключей {p} внутри репозитория: перенесите её (docs/UPDATES.md)")
    if not (p / "key4.db").exists():
        die(f"нет базы ключей в {p}: задайте TABORA_MAR_KEYS_DIR (docs/UPDATES.md)")
    mode = p.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        die(f"каталог ключей {p} доступен другим пользователям: chmod 700 {p}")
    return p


def password_file() -> Optional[Path]:
    path = os.environ.get("TABORA_MAR_KEYS_PASSWORD_FILE")
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        die(f"нет файла пароля {p}")
    if p.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        die(f"файл пароля {p} доступен другим пользователям: chmod 600 {p}")
    return p


# ---------------------------------------------------------------------------
# Инструменты: signmar, make_full_update.sh, createprecomplete.py

class Tools:
    def __init__(self, signmar: Path, update_packaging: Path, precomplete: Path,
                 lib_dir: Optional[Path], certutil: Optional[Path]):
        self.signmar = signmar
        self.update_packaging = update_packaging
        self.precomplete = precomplete
        self.lib_dir = lib_dir
        self.certutil = certutil

    def env(self) -> dict:
        env = dict(os.environ)
        if self.lib_dir:
            env["DYLD_LIBRARY_PATH"] = str(self.lib_dir)
            env["LD_LIBRARY_PATH"] = str(self.lib_dir)
        return env


def find_tools(args, plat: str, arch: str) -> Tools:
    if args.tools:
        # каталог из `release.py tools`: собран из проверенных исходников Firefox
        t = Path(args.tools).resolve()
        certutil = shutil.which("certutil")
        return Tools(t / "signmar", t / "update-packaging", t / "createprecomplete.py", None,
                     Path(certutil) if certutil else None)
    # локально: собственная сборка владельца
    bin_dir = objdir(plat, arch) / "dist" / "bin"
    if plat != buildtool.host_platform() or arch != buildtool.host_arch():
        die("для кросс-цели укажите --tools (signmar для этой машины)")
    certutil = bin_dir / "certutil"
    return Tools(bin_dir / "signmar", ENGINE / "tools" / "update-packaging",
                 ENGINE / "config" / "createprecomplete.py", bin_dir,
                 certutil if certutil.exists() else None)


def compile_signmar(firefox_src: Path, out: Path) -> Path:
    """signmar (создание, подпись и проверка MAR) из modules/libmar исходников Firefox и
    системной NSS (pkg-config nss nspr)."""
    pkg = subprocess.run(["pkg-config", "--cflags", "--libs", "nss", "nspr"], check=True,
                         capture_output=True, text=True).stdout.split()
    lib = firefox_src / "modules" / "libmar"
    city = firefox_src / "other-licenses" / "nsis" / "Contrib" / "CityHash" / "cityhash"
    objs = out / "obj"
    objs.mkdir(parents=True, exist_ok=True)
    cxx = os.environ.get("CXX", "c++")
    cc = os.environ.get("CC", "cc")
    sh([cxx, "-O2", "-c", city / "city.cpp", f"-I{city}", "-o", objs / "city.o"])
    sources = [lib / "tool" / "mar.c", lib / "src" / "mar_create.c", lib / "src" / "mar_extract.c",
               lib / "src" / "mar_read.c", lib / "sign" / "mar_sign.c", lib / "sign" / "nss_secutil.c",
               lib / "verify" / "cryptox.c", lib / "verify" / "mar_verify.c"]
    flags = ["-O2", "-DMAR_NSS", f'-DMAR_CHANNEL_ID="{buildtool.MAR_CHANNEL_ID}"', '-DMOZ_APP_VERSION="0"',
             f"-I{lib / 'src'}", f"-I{lib / 'sign'}", f"-I{lib / 'verify'}", f"-I{city}",
             *[f for f in pkg if f.startswith("-I")]]
    for source in sources:
        sh([cc, *flags, "-c", source, "-o", objs / (source.stem + ".o")])
    signmar = out / "signmar"
    sh([cxx, "-o", signmar, *sorted(objs.glob("*.o")), *[f for f in pkg if not f.startswith("-I")]])
    shutil.rmtree(objs)
    return signmar


def cmd_tools(args) -> None:
    """CI: скачать исходники Firefox (хеш закреплён в browser.json), взять из них
    libmar и скрипты упаковки и собрать signmar с системной NSS. Бинарники из
    артефакта сборки в задании с ключами не запускаются."""
    config = cfg()
    version = config["firefox"]["version"]
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    archive = buildtool.fetch_source_archive(config)
    top = f"firefox-{version}"
    members = [f"{top}/modules/libmar", f"{top}/other-licenses/nsis/Contrib/CityHash/cityhash",
               f"{top}/tools/update-packaging", f"{top}/config/createprecomplete.py"]
    src = out / "src"
    src.mkdir()
    tar = shutil.which("gtar") or "tar"
    sh([tar, "-xJf", archive, "-C", src, "--no-same-owner", *members])
    s = src / top
    shutil.copytree(s / "tools" / "update-packaging", out / "update-packaging", symlinks=True)
    shutil.copy(s / "config" / "createprecomplete.py", out / "createprecomplete.py")
    compile_signmar(s, out)
    shutil.rmtree(src)
    print(f"инструменты: {out}")


# ---------------------------------------------------------------------------
# Приложение

def packaged_app(plat: str, arch: str) -> Path:
    stage = objdir(plat, arch) / "dist" / "tabora"
    app = stage / "Tabora.app" if plat == "darwin" else stage
    if not (app / ("Contents/Resources/application.ini" if plat == "darwin" else "application.ini")).exists():
        die(f"нет упакованного приложения в {app}: сначала `python3 tools/build.py package`")
    return app


def safe_extract_app_tar(tar_path: Path, dest: Path, plat: str) -> Path:
    """Распаковать архив приложения из артефакта: только обычные файлы и каталоги внутри
    dest, без ссылок, абсолютных путей и «..»."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(tar_path) as tf:
        members = tf.getmembers()
        for m in members:
            name = m.name
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                die(f"недопустимый путь в архиве приложения: {name!r}")
            if not (m.isfile() or m.isdir()):
                die(f"в архиве приложения не файл и не каталог: {name!r}")
            if m.isfile():
                m.mode &= 0o755
            m.uid = m.gid = 0
            m.uname = m.gname = ""
        if sys.version_info >= (3, 9) and hasattr(tarfile, "data_filter"):
            tf.extractall(dest, members=members, filter="data")
        else:
            tf.extractall(dest, members=members)
    root = dest / "Tabora.app" if plat == "darwin" else dest / "tabora"
    if not root.is_dir():
        die(f"в архиве нет {root.name}")
    return root


def check_tree(app: Path) -> None:
    """Без символических ссылок (MAR их не переносит) и без опасных для shell имён."""
    for path in app.rglob("*"):
        rel = path.relative_to(app)
        if path.is_symlink():
            die(f"символическая ссылка в приложении: {rel}")
        for part in rel.parts:
            if not SAFE_NAME_RE.match(part):
                die(f"недопустимое имя файла в приложении: {str(rel)!r}")


def app_ini(app: Path, plat: str) -> Path:
    return app / "Contents" / "Resources" / "application.ini" if plat == "darwin" else app / "application.ini"


def ini_value(ini: Path, section: str, key: str) -> Optional[str]:
    current = None
    for line in ini.read_text().splitlines():
        line = line.strip()
        if line.startswith("["):
            current = line.strip("[]")
        elif current == section and line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return None


def build_id(app: Path, plat: str) -> str:
    value = ini_value(app_ini(app, plat), "App", "BuildID")
    if not value or not re.match(r"^\d{14}$", value):
        die("в application.ini нет BuildID")
    return value


def app_version(app: Path, plat: str) -> str:
    value = ini_value(app_ini(app, plat), "App", "Version")
    if not value:
        die("в application.ini нет Version")
    return value


# ---------------------------------------------------------------------------
# MAR

def released_version(channel: str, target: str) -> Optional[str]:
    """Версия из уже выпущенного манифеста цели (подпись проверяется)."""
    old = read_signed_manifest(UPDATES / channel / target / "manifest.json", channel, target)
    if old is None:
        return None
    vtuple(old.get("version"))
    return old["version"]


def make_mar(args) -> dict:
    config = cfg()
    plat, arch = target_env()
    disp, ff_ver = tabora_version(config)
    channel = channel_name()
    target = build_target(plat, arch)
    published = released_version(channel, target)
    if published and vtuple(disp) < vtuple(published):
        die(f"версия {disp} ниже уже выпущенной {published}: поднимите displayVersion в browser.json")
    if published and vtuple(disp) == vtuple(published) and not args.replace:
        die(f"версия {disp} уже выпущена для {target}: поднимите displayVersion или укажите --replace")
    tools = find_tools(args, plat, arch)
    for p in (tools.signmar, tools.update_packaging / "make_full_update.sh", tools.precomplete):
        if not p.exists():
            die(f"нет {p}")

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"tabora-{disp}-{plat}-{arch}.complete.mar"
    signed = RELEASE_DIR / name
    if signed.exists():
        signed.unlink()
    work = Path(tempfile.mkdtemp(prefix="stage-", dir=RELEASE_DIR))
    try:
        if args.app_tar:
            app = safe_extract_app_tar(Path(args.app_tar), work / "app", plat)
        else:
            src_app = packaged_app(plat, arch)
            app = work / "app" / src_app.name
            app.parent.mkdir(parents=True)
            # ссылки не разыменовываются: если они есть, check_tree остановит выпуск
            shutil.copytree(src_app, app, symlinks=True)
        check_tree(app)
        buildtool.verify_packaged_app(app, plat, config)
        if app_version(app, plat) != ff_ver:
            die(f"в приложении Firefox {app_version(app, plat)}, в browser.json {ff_ver}")
        bid = build_id(app, plat)

        unsigned = work / f"{name}.unsigned"
        env = tools.env()
        env.update({
            "MAR": str(tools.signmar),
            "MOZ_PRODUCT_VERSION": disp,  # версия Tabora: её сверяет обновлятор (TABORA_APP_VERSION)
            "MAR_CHANNEL_ID": buildtool.MAR_CHANNEL_ID,
        })
        spec = importlib.util.spec_from_file_location("createprecomplete", tools.precomplete)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.generate_precomplete(str(app / "Contents" / "Resources") if plat == "darwin" else str(app))
        sh(["bash", tools.update_packaging / "make_full_update.sh", unsigned, app], env=env)
        shutil.rmtree(work / "app")
        sign_mar(tools, unsigned, signed, args.key)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    check_mar_info(tools, signed, disp)
    size = signed.stat().st_size
    sha = hashlib.sha512(signed.read_bytes()).hexdigest()
    meta = {
        "name": name, "size": size, "sha512": sha, "version": disp, "appVersion": ff_ver,
        "buildID": bid, "target": target, "channel": channel, "platform": plat, "arch": arch,
    }
    (RELEASE_DIR / f"{name}.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta, indent=2, ensure_ascii=False))
    return meta


def sign_mar(tools: Tools, unsigned: Path, signed: Path, which: str) -> None:
    db = keys_dir(which)
    cert = CERT_NAMES[which]
    der = buildtool.MAR_CERTS_DIR / f"release_{which}.der"
    buildtool.verify_mar_certs()
    env = tools.env()
    if tools.certutil:
        # сертификат в базе должен совпадать с тем, что зашит в обновлятор
        out = subprocess.run([str(tools.certutil), "-L", "-d", f"sql:{db}", "-n", cert, "-r"],
                             env=env, capture_output=True, check=True).stdout
        if out != der.read_bytes():
            die(f"сертификат {cert} в {db} не совпадает с {der.relative_to(ROOT)}")
    # пароль базы: из файла (CI) или signmar спросит его в терминале; без терминала и
    # файла — пустой ввод (база без пароля)
    pw = password_file()
    if pw:
        with open(pw) as stdin:
            sh([tools.signmar, "-d", f"sql:{db}", "-n", cert, "-s", unsigned, signed], env=env, stdin=stdin)
    elif sys.stdin.isatty():
        sh([tools.signmar, "-d", f"sql:{db}", "-n", cert, "-s", unsigned, signed], env=env)
    else:
        sh([tools.signmar, "-d", f"sql:{db}", "-n", cert, "-s", unsigned, signed], env=env,
           stdin=subprocess.DEVNULL)
    # проверка подписи: на macOS signmar сверяет с DER-файлом, на Linux — с сертификатом из
    # базы (выше сверен с тем же DER)
    if buildtool.host_platform() == "darwin":
        sh([tools.signmar, "-D", der, "-v", signed], env=env)
    else:
        sh([tools.signmar, "-d", f"sql:{db}", "-n", cert, "-v", signed], env=env)
    unsigned.unlink()


def check_mar_info(tools: Tools, mar: Path, version: str) -> None:
    out = sh([tools.signmar, "-T", mar], env=tools.env(), capture=True).stdout
    channel = re.search(r"MAR channel name: (\S+)", out)
    product = re.search(r"Product version: (\S+)", out)
    if not channel or channel.group(1) != buildtool.MAR_CHANNEL_ID:
        die(f"в MAR не тот канал: {channel.group(1) if channel else '?'}")
    if not product or product.group(1) != version:
        die(f"в MAR не та версия: {product.group(1) if product else '?'}")
    if "Signature block found with 1 signature" not in out:
        die("в MAR нет подписи")


def latest_meta() -> dict:
    """Последний собранный MAR этой цели: наибольшая версия Tabora, а не порядок имён."""
    plat, arch = target_env()
    target = build_target(plat, arch)
    metas = []
    for path in RELEASE_DIR.glob("*.complete.mar.json"):
        meta = json.loads(path.read_text())
        if meta.get("target") == target and VERSION_RE.match(meta.get("version", "")):
            metas.append(meta)
    if not metas:
        die(f"нет собранного MAR для {target}: сначала tools/release.py mar")
    return max(metas, key=lambda m: vtuple(m["version"]))


# ---------------------------------------------------------------------------
# Манифесты

NODE_SIGN = r"""
import { createPrivateKey, createPublicKey, sign, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const key = createPrivateKey({ key: readFileSync(input.key), format: "pem", passphrase: input.passphrase || undefined });
const raw = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
const keyid = createHash("sha256").update(raw).digest("hex").slice(0, 16);
const sig = sign(null, Buffer.from(input.data, "base64"), key).toString("base64");
process.stdout.write(JSON.stringify({ keyid, sig, public: raw.toString("base64") }));
"""


NODE_VERIFY = r"""
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const spki = Buffer.from("302a300506032b6570032100", "hex");
const data = Buffer.from(input.data, "base64");
let keyid = null;
for (const s of input.signatures.slice(0, 4)) {
  const raw = typeof s?.keyid === "string" && Object.hasOwn(input.keys, s.keyid) ? input.keys[s.keyid] : null;
  if (!raw || typeof s.sig !== "string") continue;
  try {
    const key = createPublicKey({ key: Buffer.concat([spki, Buffer.from(raw, "base64")]), format: "der", type: "spki" });
    if (verify(null, data, key, Buffer.from(s.sig, "base64"))) { keyid = s.keyid; break; }
  } catch (e) {}
}
process.stdout.write(JSON.stringify({ keyid }));
"""


def read_signed_manifest(path: Path, channel: str, target: str) -> Optional[dict]:
    """Подписанная часть уже выпущенного манифеста. None — файла нет. Содержимое updates/
    само по себе не доверенное (его можно изменить коммитом): без подписи одним из ключей
    MANIFEST_KEYS и совпадения канала и цели файл не используется и выпуск останавливается."""
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        text, signatures = doc["signed"], doc["signatures"]
        if not isinstance(text, str) or not isinstance(signatures, list):
            raise ValueError
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError
        data = base64.b64encode(text.encode("utf-8")).decode()
    except (KeyError, ValueError, TypeError):
        die(f"повреждён {path}: восстановите его из git или удалите (тогда цель выпускается заново)")
    node = shutil.which("node")
    if not node:
        die("нужен node (проверка подписи Ed25519)")
    res = subprocess.run([node, "--input-type=module", "-e", NODE_VERIFY], capture_output=True, text=True,
                         check=True, input=json.dumps({"keys": embedded_manifest_keys(), "data": data,
                                                       "signatures": signatures}))
    if not json.loads(res.stdout).get("keyid"):
        die(f"подпись {path} не проверена ключами MANIFEST_KEYS: файл изменён не release.py. "
            "Восстановите его из git или удалите (тогда цель выпускается заново)")
    if payload.get("channel") != channel or payload.get("target") != target:
        die(f"{path}: манифест другого канала или цели ({payload.get('channel')}/{payload.get('target')})")
    return payload


def manifest_passphrase(key: Path) -> str:
    if "ENCRYPTED" not in key.read_text():
        return ""
    pw = password_file()
    if pw:
        return pw.read_text().splitlines()[0]
    return getpass.getpass(f"Пароль {key}: ")


def sign_text(text: str, which: str) -> dict:
    key = keys_dir(which) / MANIFEST_KEY_FILE
    if not key.exists():
        die(f"нет ключа подписи манифестов {key} (docs/UPDATES.md)")
    if key.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        die(f"ключ {key} доступен другим пользователям: chmod 600 {key}")
    node = shutil.which("node")
    if not node:
        die("нужен node (подпись Ed25519)")
    payload = json.dumps({"key": str(key), "passphrase": manifest_passphrase(key),
                          "data": base64.b64encode(text.encode("utf-8")).decode()})
    res = subprocess.run([node, "--input-type=module", "-e", NODE_SIGN], input=payload,
                         capture_output=True, text=True, check=True)
    out = json.loads(res.stdout)
    known = embedded_manifest_keys()
    if known.get(out["keyid"]) != out["public"]:
        die(f"ключ {key} (keyid {out['keyid']}) не зашит в TaboraUpdate.sys.mjs (MANIFEST_KEYS)")
    return {"keyid": out["keyid"], "sig": out["sig"]}


def embedded_manifest_keys() -> Dict[str, str]:
    path = ROOT / "src/browser/base/content/tabora/update/TaboraUpdate.sys.mjs"
    block = re.search(r"MANIFEST_KEYS = Object\.freeze\(\{(.*?)\}\)", path.read_text(), re.S)
    if not block:
        die("в TaboraUpdate.sys.mjs нет MANIFEST_KEYS")
    return dict(re.findall(r'"([0-9a-f]{16})":\s*"([A-Za-z0-9+/=]{44})"', block.group(1)))


def update_xml(meta: dict, mar_url: str, details: str) -> bytes:
    root = ET.Element("updates")
    upd = ET.SubElement(root, "update", {
        "type": "minor",
        "displayVersion": meta["version"],
        "taboraVersion": meta["version"],
        "appVersion": meta["appVersion"],
        "buildID": meta["buildID"],
        "detailsURL": details,
    })
    ET.SubElement(upd, "patch", {
        "type": "complete",
        "URL": mar_url,
        "hashFunction": "sha512",
        "hashValue": meta["sha512"],
        "size": str(meta["size"]),
    })
    ET.indent(root)
    return b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8") + b"\n"


def check_text(value: Optional[str], limit: int, what: str) -> str:
    value = value or ""
    if len(value) > limit:
        die(f"{what} длиннее {limit} символов")
    if any(ord(c) < 32 and c not in "\n\t" for c in value):
        die(f"{what}: управляющие символы")
    return value


def https_url(value: str, what: str) -> str:
    if not re.match(r"^https://[^/?#@\s\\]+/\S*$", value) or len(value) > 512:
        die(f"{what} не https-адрес: {value!r}")
    return value


def write_signed_manifest(path: Path, payload: dict, which: str) -> None:
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    doc = {"signed": text, "signatures": [sign_text(text, which)]}
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")


def write_manifests(args, meta: dict) -> Tuple[str, str]:
    config = cfg()
    brand = config["brands"][config["brand"]]
    repo = config["repository"].rstrip("/")
    tag = f"v{meta['version']}"
    mar_url = https_url(f"{repo}/releases/download/{tag}/{meta['name']}", "адрес пакета")
    channel = meta["channel"]
    target_dir = UPDATES / channel / meta["target"]
    target_dir.mkdir(parents=True, exist_ok=True)
    details = https_url(brand.get("urls", {}).get("releaseNotes") or f"{repo}/releases/tag/{tag}", "адрес заметок")
    notes = check_text(args.notes, 2000, "заметки")
    manifest_path = target_dir / "manifest.json"
    # старый манифест — только с проверенной подписью (иначе read_signed_manifest остановит)
    old = read_signed_manifest(manifest_path, channel, meta["target"]) or {}
    if old and vtuple(meta["version"]) < vtuple(old.get("version")):
        die(f"версия {meta['version']} ниже уже выпущенной {old['version']}: манифест отката не подписывается")
    same_version = bool(old) and old.get("version") == meta["version"]
    if args.minimum:
        minimum = args.minimum
        if old.get("minimum") and vtuple(minimum) < vtuple(old["minimum"]):
            print(f"! минимальная версия понижается: {old['minimum']} → {minimum}")
    elif old.get("minimum"):
        minimum = old["minimum"]
        vtuple(minimum)
        print(f"минимальная версия {minimum} — из прежнего подписанного манифеста (изменить: --minimum)")
    else:
        # обязательным обновление делает только явный --minimum
        minimum = NO_MINIMUM
        print(f"минимальная версия не задана: {NO_MINIMUM}, обязательного обновления нет (задать: --minimum)")
    if vtuple(minimum) > vtuple(meta["version"]):
        die(f"минимальная версия {minimum} выше выпускаемой {meta['version']}")
    if args.notes is None and same_version and old.get("notes"):
        notes = check_text(old["notes"], 2000, "заметки")
        print("заметки — из прежнего подписанного манифеста этой же версии (изменить: --notes)")
    issued = issued_at(old)
    today = date.today()
    payload = {
        "format": MANIFEST_FORMAT,
        "channel": channel,
        "target": meta["target"],
        "version": meta["version"],
        "minimum": minimum,
        "notes": notes,
        "notesUrl": details,
        "published": old["published"] if same_version and old.get("published") else today.isoformat(),
        "issued": time_text(issued),
        "expires": expires_at(args.valid_days, issued),
        "update": {
            "url": mar_url, "sha512": meta["sha512"], "size": meta["size"],
            "buildID": meta["buildID"], "appVersion": meta["appVersion"],
        },
    }
    (target_dir / "update.xml").write_bytes(update_xml(meta, mar_url, details))
    write_signed_manifest(manifest_path, payload, args.key)
    write_legacy_channel(channel, payload)
    print(f"манифесты: {manifest_path}, {target_dir / 'update.xml'}, {UPDATES / 'channel.json'}")
    return tag, mar_url


TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
NO_MINIMUM = "0.0.0"


def time_text(when: datetime) -> str:
    return when.strftime(TIME_FORMAT)


def issued_at(old: Optional[dict]) -> datetime:
    """Время подписи нового манифеста: строго больше, чем у прежнего (клиент отвергает
    манифест старее уже виденного)."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    prev_text = (old or {}).get("issued")
    if prev_text is None:
        return now
    try:
        prev = datetime.strptime(prev_text, TIME_FORMAT).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        die(f"неверное время подписи в прежнем манифесте: {prev_text!r}")
    if prev - now > timedelta(days=1):
        die(f"прежний манифест подписан в будущем ({prev_text}): проверьте часы этой машины")
    return max(now, prev + timedelta(seconds=1))


def expires_at(days: int, issued: datetime) -> str:
    if not 7 <= days <= 365:
        die("срок действия манифеста: от 7 до 365 дней")
    return time_text(issued + timedelta(days=days))


def write_legacy_channel(channel: str, payload: dict) -> None:
    """updates/channel.json читают сборки до подписанных манифестов. Их обновлятор не
    принимает наши пакеты (старые сертификаты), поэтому minimum здесь не поднимается:
    старые копии видят новую версию и ставят её с сайта, но не блокируются."""
    path = UPDATES / "channel.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    entry = data.get(channel, {})
    entry.update({
        "version": payload["version"],
        "minimum": entry.get("minimum") or "0.1.0",
        "notes": payload["notes"],
        "notesUrl": payload["notesUrl"],
        "published": payload["published"],
    })
    data[channel] = entry
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def cmd_refresh(args) -> None:
    """Продлить срок действия манифестов (без нового выпуска) — не реже, чем раз в срок.
    Меняются только issued и expires; подпись каждого файла сначала проверяется, и если
    хоть один не проверен, не переподписывается ни один."""
    items = []
    for path in sorted(UPDATES.glob("*/*/manifest.json")):
        channel, target = path.parent.parent.name, path.parent.name
        items.append((path, read_signed_manifest(path, channel, target)))
    if not items:
        print("нет манифестов")
        return
    for path, old in items:
        issued = issued_at(old)
        payload = dict(old)
        payload["issued"] = time_text(issued)
        payload["expires"] = expires_at(args.valid_days, issued)
        changed = sorted(k for k in set(old) | set(payload) if old.get(k) != payload.get(k))
        if not set(changed) <= {"issued", "expires"}:
            die(f"{path}: refresh меняет только issued и expires, а не {changed}")
        write_signed_manifest(path, payload, args.key)
        print(f"продлён {path}: версия {payload.get('version')}, минимальная {payload.get('minimum')}")
        for k in changed:
            print(f"  {k}: {old.get(k)} → {payload[k]}")
        print("  остальные поля без изменений")


# ---------------------------------------------------------------------------
# Команды

def cmd_check(args) -> None:
    plat, arch = target_env()
    if not args.app_tar:
        app = packaged_app(plat, arch)
        check_tree(app)
        buildtool.verify_packaged_app(app, plat, cfg())
        print(f"приложение {app} в порядке")
        return
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="check-", dir=RELEASE_DIR))
    try:
        app = safe_extract_app_tar(Path(args.app_tar), work / "app", plat)
        check_tree(app)
        buildtool.verify_packaged_app(app, plat, cfg())
        print(f"приложение из {args.app_tar} в порядке")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cmd_mar(args) -> None:
    make_mar(args)


def cmd_manifest(args) -> None:
    write_manifests(args, latest_meta())


def gh_release(tag: str) -> Optional[dict]:
    res = subprocess.run(["gh", "release", "view", tag, "--json", "assets,isDraft"], capture_output=True, text=True)
    if res.returncode != 0:
        return None
    data = json.loads(res.stdout)
    return {"draft": bool(data.get("isDraft")), "assets": {a["name"]: a.get("size", 0) for a in data.get("assets", [])}}


def upload_release(meta: dict, mar: Path, dmgs: List[Path], notes: str, replace: bool,
                   target: Optional[str] = None, draft: bool = False) -> str:
    """Релиз GitHub с пакетом. target — коммит, на который ставится тег (коммит сборки);
    draft — создать черновик (публикуется отдельно, после пуша манифестов)."""
    tag = f"v{meta['version']}"
    assets = [mar, *dmgs]
    existing = gh_release(tag)
    if existing is None:
        cmd = ["gh", "release", "create", tag, *assets, "--title", f"Tabora {meta['version']}", "--notes", notes]
        if target:
            cmd += ["--target", target]
        if draft:
            cmd += ["--draft"]
        sh(cmd)
    else:
        if meta["name"] in existing["assets"] and not replace and not existing["draft"]:
            die(f"в релизе {tag} уже есть {meta['name']}: укажите --replace, если пакет заменяется намеренно")
        try:
            sh(["gh", "release", "upload", tag, *assets, "--clobber"])
        except subprocess.CalledProcessError:
            if existing["draft"]:
                raise
            # в репозитории включены immutable releases: опубликованный релиз не меняется
            die(f"GitHub не принял файлы в опубликованный релиз {tag} (релизы неизменяемы): "
                "поднимите displayVersion и выпустите новую версию")
    return tag


def pushed_head() -> Optional[str]:
    """Текущий коммит, если он уже есть на GitHub (иначе тег на него поставить нельзя)."""
    try:
        head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                              check=True).stdout.strip()
        remote = subprocess.run(["git", "-C", str(ROOT), "branch", "-r", "--contains", head], capture_output=True,
                                text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return head if remote and re.match(r"^[0-9a-f]{40}$", head) else None


def cmd_publish(args) -> None:
    meta = make_mar(args)
    write_manifests(args, meta)
    plat, arch = target_env()
    dmgs = sorted((objdir(plat, arch) / "dist").glob("*.dmg")) if not args.app_tar else []
    notes = check_text(args.notes, 2000, "заметки") or f"Tabora {meta['version']}"
    target = pushed_head()
    if not target:
        print("! текущий коммит не отправлен на GitHub: тег релиза встанет на вершину ветки по умолчанию")
    upload_release(meta, RELEASE_DIR / meta["name"], dmgs, notes, args.replace, target=target)
    print("Готово. Теперь закоммитьте и запушьте папку updates/, чтобы клиенты увидели обновление:")
    print(f"  git add updates && git commit -m 'Обновление {meta['version']}' && git push")


def cmd_upload(args) -> None:
    """CI, задание без ключей: загрузить подписанный MAR и dmg в релиз GitHub."""
    meta = json.loads(Path(args.meta).read_text())
    vtuple(meta["version"])
    if not re.match(r"^tabora-[0-9.]+-(darwin|linux)-(aarch64|x86_64)\.complete\.mar$", meta["name"]):
        die(f"неожиданное имя пакета {meta['name']!r}")
    mar = Path(args.meta).with_name(meta["name"])
    if hashlib.sha512(mar.read_bytes()).hexdigest() != meta["sha512"]:
        die("sha512 пакета не совпадает с метаданными")
    notes = check_text(args.notes, 2000, "заметки") or f"Tabora {meta['version']}"
    if args.target and not re.match(r"^[0-9a-f]{40}$", args.target):
        die("--target: нужен полный SHA коммита")
    upload_release(meta, mar, [Path(p) for p in args.dmg], notes, args.replace, target=args.target, draft=args.draft)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, signing=True):
        p.add_argument("--app-tar", help="архив приложения из артефакта CI вместо engine/obj-*/dist/tabora")
        p.add_argument("--tools", help="каталог из `release.py tools` (signmar и скрипты упаковки)")
        if signing:
            p.add_argument("--key", choices=("primary", "secondary"), default="primary",
                           help="каким ключом подписывать (secondary — только при утрате основного)")
            p.add_argument("--replace", action="store_true", help="разрешить повторный выпуск той же версии")
        return p

    def manifest_opts(p):
        p.add_argument("--minimum", help="минимально допустимая версия X.Y.Z (ниже — обновление обязательное); "
                                         "без флага — как в прежнем подписанном манифесте, а при первом выпуске "
                                         "цели 0.0.0 (обязательности нет)")
        p.add_argument("--notes", help="что нового (до 2000 символов)")
        p.add_argument("--valid-days", type=int, default=DEFAULT_VALID_DAYS, help="срок действия манифеста, дней")
        return p

    common(sub.add_parser("check", help="проверить упакованное приложение"), signing=False).set_defaults(fn=cmd_check)
    common(sub.add_parser("mar", help="собрать и подписать MAR")).set_defaults(fn=cmd_mar)
    p = manifest_opts(sub.add_parser("manifest", help="манифесты по последнему MAR этой цели"))
    p.add_argument("--key", choices=("primary", "secondary"), default="primary")
    p.set_defaults(fn=cmd_manifest)
    manifest_opts(common(sub.add_parser("publish", help="MAR, манифесты и релиз GitHub"))).set_defaults(fn=cmd_publish)
    p = sub.add_parser("refresh", help="продлить срок действия манифестов")
    p.add_argument("--key", choices=("primary", "secondary"), default="primary")
    p.add_argument("--valid-days", type=int, default=DEFAULT_VALID_DAYS)
    p.set_defaults(fn=cmd_refresh)
    p = sub.add_parser("tools", help="(CI) signmar и скрипты упаковки из проверенных исходников Firefox")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_tools)
    p = sub.add_parser("upload", help="(CI) загрузить подписанный MAR в релиз GitHub")
    p.add_argument("--meta", required=True, help=".complete.mar.json рядом с пакетом")
    p.add_argument("--dmg", action="append", default=[])
    p.add_argument("--notes")
    p.add_argument("--replace", action="store_true")
    p.add_argument("--target", help="SHA коммита сборки: на него ставится тег релиза")
    p.add_argument("--draft", action="store_true", help="создать черновик (публикуется после пуша манифестов)")
    p.set_defaults(fn=cmd_upload)

    args = ap.parse_args()
    if getattr(args, "minimum", None):
        vtuple(args.minimum)
    args.fn(args)


if __name__ == "__main__":
    main()
