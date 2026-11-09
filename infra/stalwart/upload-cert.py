#!/usr/bin/env python3
"""Загрузка сертификата Let's Encrypt в Stalwart (объект x:Certificate) и назначение его
сертификатом по умолчанию. Вызывается enable-tls.sh и хуком обновления certbot.
Использование: upload-cert.py /etc/letsencrypt/live/mx.tabora.app
"""
import base64
import json
import os
import sys
import urllib.request

live = sys.argv[1] if len(sys.argv) > 1 else None
if not live or not os.path.isdir(live):
    raise SystemExit("укажите каталог сертификата, например /etc/letsencrypt/live/mx.tabora.app")
ENV = dict(l.strip().split("=", 1) for l in open("/etc/tabora/server.env") if "=" in l and not l.startswith("#"))
URL = ENV.get("STALWART_URL", "http://127.0.0.1:8080") + "/jmap"
AUTH = base64.b64encode(f"{ENV['STALWART_ADMIN_USER']}:{ENV['STALWART_ADMIN_PASS']}".encode()).decode()


def call(method, args):
    body = json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": [[method, args, "c0"]]}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json", "Authorization": f"Basic {AUTH}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.load(r)["methodResponses"][0]
    if resp[0] == "error":
        raise SystemExit(f"{method}: {resp[1]}")
    for key in ("notCreated", "notUpdated"):
        if resp[1].get(key):
            raise SystemExit(f"{method} {key}: {json.dumps(resp[1][key], ensure_ascii=False)}")
    return resp[1]


cert = open(os.path.join(live, "fullchain.pem")).read()
key = open(os.path.join(live, "privkey.pem")).read()
existing = call("x:Certificate/get", {"ids": None})["list"]
ss = call("x:SystemSettings/get", {"ids": ["singleton"]})["list"][0]
current_id = ss.get("defaultCertificateId")
if current_id and any(c["id"] == current_id for c in existing):
    call("x:Certificate/set", {"update": {current_id: {"certificate": cert, "privateKey": key}}})
    print(f"сертификат {current_id} обновлён")
else:
    r = call("x:Certificate/set", {"create": {"c": {"certificate": cert, "privateKey": key}}})
    cid = r["created"]["c"]["id"]
    call("x:SystemSettings/set", {"update": {"singleton": {"defaultCertificateId": cid}}})
    print(f"сертификат {cid} загружен и назначен по умолчанию")
