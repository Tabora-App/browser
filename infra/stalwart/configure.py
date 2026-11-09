#!/usr/bin/env python3
"""Настройка Stalwart 1.x через JMAP-объекты администратора (идемпотентно).

Слушатели: HTTP только на localhost (снаружи nginx с TLS), порт 443 Stalwart не занимает,
POP3 выключен, добавлен submission 587. Домен и системные настройки: имя хоста mx.<домен>,
домен по умолчанию, MX. Сертификат загружает upload-cert.py после выпуска Let's Encrypt.
"""
import json
import os
import sys
import urllib.request
import base64

ENV = {}
for line in open("/etc/tabora/server.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        ENV[k] = v
DOMAIN = ENV.get("TABORA_DOMAIN", "tabora.app")
MAIL_HOST = os.environ.get("MAIL_HOST", f"mx.{DOMAIN}")
URL = ENV.get("STALWART_URL", "http://127.0.0.1:8080") + "/jmap"
AUTH = base64.b64encode(f"{ENV['STALWART_ADMIN_USER']}:{ENV['STALWART_ADMIN_PASS']}".encode()).decode()


def call(method, args):
    body = json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": [[method, args, "c0"]]}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json", "Authorization": f"Basic {AUTH}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.load(r)["methodResponses"][0]
    if resp[0] == "error":
        raise SystemExit(f"{method}: {resp[1]}")
    r = resp[1]
    for key in ("notCreated", "notUpdated", "notDestroyed"):
        if r.get(key):
            raise SystemExit(f"{method} {key}: {json.dumps(r[key], ensure_ascii=False)}")
    return r


def log(msg):
    print(f"\033[1;32m›\033[0m {msg}")


# ---- слушатели ----------------------------------------------------------------
listeners = {l["name"]: l for l in call("x:NetworkListener/get", {"ids": None})["list"]}
update, destroy, create = {}, [], {}
if "http" in listeners and list(listeners["http"]["bind"]) != ["127.0.0.1:8080"]:
    update[listeners["http"]["id"]] = {"bind": {"127.0.0.1:8080": True}}
for name in ("https", "pop3s", "pop3"):
    if name in listeners:
        destroy.append(listeners[name]["id"])
if "submission" not in listeners:
    create["sub"] = {"name": "submission", "bind": {"[::]:587": True}, "protocol": "smtp", "useTls": True, "implicitTls": False}
if update or destroy or create:
    call("x:NetworkListener/set", {k: v for k, v in (("update", update), ("destroy", destroy), ("create", create)) if v})
    log(f"слушатели: изменено {len(update)}, удалено {len(destroy)}, создано {len(create)}")
else:
    log("слушатели уже настроены")

# ---- домен ----------------------------------------------------------------------
domains = {d["name"]: d for d in call("x:Domain/get", {"ids": None})["list"]}
if DOMAIN not in domains:
    r = call("x:Domain/set", {"create": {"d": {"name": DOMAIN}}})
    domain_id = r["created"]["d"]["id"]
    log(f"домен {DOMAIN} создан ({domain_id})")
else:
    domain_id = domains[DOMAIN]["id"]
    log(f"домен {DOMAIN} уже есть ({domain_id})")

# ---- системные настройки --------------------------------------------------------
ss = call("x:SystemSettings/get", {"ids": ["singleton"]})["list"][0]
patch = {}
if ss.get("defaultHostname") != MAIL_HOST:
    patch["defaultHostname"] = MAIL_HOST
if ss.get("defaultDomainId") != domain_id:
    patch["defaultDomainId"] = domain_id
mx = ss.get("mailExchangers") or {}
if not mx or list(mx.values())[0].get("hostname") != MAIL_HOST:
    patch["mailExchangers"] = {"0": {"hostname": MAIL_HOST, "priority": 10}}
services = ss.get("services") or {}
new_services = dict(services)
for svc in ("jmap", "imap", "smtp", "managesieve", "caldav", "carddav", "webdav"):
    cur = services.get(svc, {"hostname": None, "cleartext": False})
    if cur.get("hostname") != MAIL_HOST:
        new_services[svc] = {**cur, "hostname": MAIL_HOST}
if new_services != services:
    patch["services"] = new_services
if patch:
    call("x:SystemSettings/set", {"update": {"singleton": patch}})
    log(f"системные настройки: {', '.join(patch)}")
else:
    log("системные настройки уже заданы")

# ---- зона DNS для публикации ----------------------------------------------------
d = call("x:Domain/get", {"ids": [domain_id]})["list"][0]
zone = d.get("dnsZoneFile") or ""
if zone:
    os.makedirs("/etc/tabora", exist_ok=True)
    open(f"/etc/tabora/dns-{DOMAIN}.zone", "w").write(zone)
    log(f"DNS-записи домена записаны в /etc/tabora/dns-{DOMAIN}.zone")
else:
    log("поля домена: " + ", ".join(sorted(d.keys())))
