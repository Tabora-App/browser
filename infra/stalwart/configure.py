#!/usr/bin/env python3
"""Настройка Stalwart 1.x через JMAP-объекты администратора (идемпотентно).

  configure.py admin-ok      код 0, если постоянный администратор из stalwart-admin.env входит
  configure.py recovery-on   добавить временного аварийного администратора в stalwart.env
  configure.py recovery-off  убрать его из stalwart.env
  configure.py bootstrap     от имени аварийного администратора: домен и постоянный администратор
  configure.py [apply]       от имени постоянного администратора: всё остальное

Коды выхода recovery-on/off и apply: 0 — ничего не изменилось, 3 — изменилось, нужен перезапуск
службы stalwart; остальное — ошибка.

Постоянный администратор: учётка <случайное имя>@<домен> с ролью Admin, пароль входит только
с 127.0.0.1/::1 (allowedIps), лежит в /etc/tabora/stalwart-admin.env (root, 600).
tabora-server: отдельная учётка с ролью User плюс управление учётками (создание, изменение,
удаление, алиасы) и чтение доменов; ключ API только с 127.0.0.1/::1 в /etc/tabora/server.env.
"""
import json
import os
import sys

sys.dont_write_bytecode = True  # без __pycache__ в /usr/local/lib/tabora
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jmap import (ADMIN_ENV, LOOPBACK, SERVER_ENV, STALWART_ENV, Client, JmapError, admin_client,  # noqa: E402
                  log, new_login, new_secret, read_env, update_env)

DOMAIN = read_env(SERVER_ENV).get("TABORA_DOMAIN") or os.environ.get("DOMAIN", "tabora.app")
MAIL_HOST = os.environ.get("MAIL_HOST", f"mx.{DOMAIN}")
NGINX_MAP = "/etc/nginx/tabora-privileged-logins.map"
ZONE_FILE = f"/etc/tabora/dns-{DOMAIN}.zone"
CHANGED = 3

# Публикуются в автонастройке и SRV. POP3 и ManageSieve выключены (Sieve есть в JMAP),
# CalDAV/CardDAV/WebDAV не публикуются, пока nginx не проксирует /dav/.
SERVICES = ("jmap", "imap", "smtp")
DROP_LISTENERS = {"pop3", "manageSieve"}   # по протоколу; https (443) занимает nginx

# Права tabora-server сверх роли User. Права User нужны целиком: Stalwart не даёт выдать
# создаваемой учётке права, которых нет у создающего, и не даёт трогать учётки с большими правами
# (администраторов). Ограничить домен в OSS-версии нельзя (тенанты есть только в Enterprise),
# но домен на сервере один.
SERVICE_PERMISSIONS = ["sysAccountGet", "sysAccountQuery", "sysAccountCreate", "sysAccountUpdate",
                       "sysAccountDestroy", "sysDomainGet", "sysDomainQuery"]

STDOUT_TRACER = {"@type": "Stdout", "enable": True, "level": "info", "ansi": False, "multiline": False,
                 "buffered": False, "lossy": False, "events": {}, "eventsPolicy": "exclude"}
# по умолчанию auth.failed уровня debug и не попадает в журнал, а по нему работает fail2ban
EVENT_LEVELS = {"auth.failed": "info"}


def password_cred(secret):
    return {"0": {"@type": "Password", "secret": secret, "allowedIps": LOOPBACK}}


def ensure_domain(c):
    for d in c.get_all("Domain"):
        if d["name"] == DOMAIN:
            return d["id"]
    r = c.call("x:Domain/set", {"create": {"d": {"name": DOMAIN}}})
    log(f"домен {DOMAIN} создан")
    return r["created"]["d"]["id"]


def find_account(c, local, domain_id):
    for a in c.get_all("Account"):
        if a.get("name") == local and a.get("domainId") == domain_id:
            return a
    return None


def local_part(login, prefix=""):
    return login.split("@", 1)[0] if login else new_login(prefix)


# ---- аварийный администратор (только на время создания постоянного) -------------------
def recovery_on():
    if read_env(STALWART_ENV).get("STALWART_RECOVERY_ADMIN"):
        return 0
    update_env(STALWART_ENV, {"STALWART_RECOVERY_ADMIN": f"{new_login('recovery-')}:{new_secret(40)}"},
               mode=0o640, group="stalwart")
    log("временный аварийный администратор добавлен в stalwart.env")
    return CHANGED


def recovery_off():
    if not read_env(STALWART_ENV).get("STALWART_RECOVERY_ADMIN"):
        return 0
    update_env(STALWART_ENV, remove=("STALWART_RECOVERY_ADMIN",), mode=0o640, group="stalwart")
    log("аварийный администратор убран из stalwart.env")
    return CHANGED


def bootstrap():
    user, _, pw = read_env(STALWART_ENV).get("STALWART_RECOVERY_ADMIN", "").partition(":")
    if not user or not pw:
        raise SystemExit("нет STALWART_RECOVERY_ADMIN в stalwart.env: сначала configure.py recovery-on и перезапуск")
    c = Client(user.strip(), pw.strip())
    domain_id = ensure_domain(c)
    local = local_part(read_env(ADMIN_ENV).get("STALWART_ADMIN_USER", ""))
    password = new_secret(48)
    acc = find_account(c, local, domain_id)
    if acc:
        c.call("x:Account/set", {"update": {acc["id"]: {"credentials": password_cred(password), "roles": {"@type": "Admin"}}}})
        log(f"администратор {local}@{DOMAIN}: новый пароль")
    else:
        c.call("x:Account/set", {"create": {"a": {
            "@type": "User", "name": local, "domainId": domain_id, "roles": {"@type": "Admin"},
            "description": "Tabora: администратор (вход только с 127.0.0.1)",
            "credentials": password_cred(password)}}})
        log(f"администратор {local}@{DOMAIN} создан")
    update_env(ADMIN_ENV, {"STALWART_ADMIN_USER": f"{local}@{DOMAIN}", "STALWART_ADMIN_PASS": password},
               mode=0o600, header="Администратор Stalwart (создан stalwart/configure.py). Вход только с 127.0.0.1.")
    if not admin_client().ok():
        raise SystemExit("постоянный администратор не входит")
    return 0


# ---- настройка -------------------------------------------------------------------------------
def configure_listeners(c):
    listeners = c.get_all("NetworkListener")
    update, destroy, create = {}, [], {}
    for li in listeners:
        if li["name"] == "https" or li.get("protocol") in DROP_LISTENERS:
            destroy.append(li["id"])
        elif li["name"] == "http" and list(li["bind"]) != ["127.0.0.1:8080"]:
            update[li["id"]] = {"bind": {"127.0.0.1:8080": True}}
    if not any(li["name"] == "submission" for li in listeners):
        create["sub"] = {"name": "submission", "bind": {"[::]:587": True}, "protocol": "smtp", "useTls": True, "implicitTls": False}
    if update or destroy or create:
        c.call("x:NetworkListener/set", {k: v for k, v in (("update", update), ("destroy", destroy), ("create", create)) if v})
        log(f"слушатели: изменено {len(update)}, удалено {len(destroy)}, создано {len(create)}")
        return True
    return False


def configure_system(c, domain_id):
    ss = c.call("x:SystemSettings/get", {"ids": ["singleton"]})["list"][0]
    patch = {}
    if ss.get("defaultHostname") != MAIL_HOST:
        patch["defaultHostname"] = MAIL_HOST
    if ss.get("defaultDomainId") != domain_id:
        patch["defaultDomainId"] = domain_id
    mx = ss.get("mailExchangers") or {}
    if not mx or list(mx.values())[0].get("hostname") != MAIL_HOST:
        patch["mailExchangers"] = {"0": {"hostname": MAIL_HOST, "priority": 10}}
    services = {s: {"hostname": MAIL_HOST, "cleartext": False} for s in SERVICES}
    if ss.get("services") != services:
        patch["services"] = services
    if patch:
        c.call("x:SystemSettings/set", {"update": {"singleton": patch}})
        log(f"системные настройки: {', '.join(patch)}")
    # адрес клиента из X-Forwarded-For (последний адрес). HTTP-слушатель только на 127.0.0.1,
    # поэтому заголовок могут прислать только местные процессы; nginx пишет туда $remote_addr.
    # Без этого все запросы через nginx считались пришедшими с 127.0.0.1 (а он никогда не банится).
    http = c.call("x:Http/get", {"ids": ["singleton"]})["list"][0]
    hp = {k: v for k, v in (("clientIpSource", "xForwardedFor"), ("forwardedHops", 1)) if http.get(k) != v}
    if hp:
        c.call("x:Http/set", {"update": {"singleton": hp}})
        log(f"HTTP: {', '.join(hp)}")
    return bool(patch or hp)


def configure_tracing(c):
    changed = False
    tracers = c.get_all("Tracer")
    # журнал в stderr → journald (stalwart.service); файловый журнал в /var/log/stalwart
    # не писался вовсе: каталога нет, а служба может писать только в data и logs
    destroy = [t["id"] for t in tracers if t.get("@type") == "Log" and not t.get("path", "").startswith("/opt/stalwart/logs")]
    stdout = [t for t in tracers if t.get("@type") == "Stdout"]
    args = {}
    if destroy:
        args["destroy"] = destroy
    if not stdout:
        args["create"] = {"t": STDOUT_TRACER}
    else:
        diff = {k: v for k, v in STDOUT_TRACER.items() if k != "@type" and stdout[0].get(k) != v}
        if diff:
            args["update"] = {stdout[0]["id"]: diff}
    if args:
        c.call("x:Tracer/set", args)
        log("журнал Stalwart: stderr → journald")
        changed = True
    current = {e["event"]: e for e in c.get_all("EventTracingLevel")}
    create, update = {}, {}
    for i, (event, level) in enumerate(EVENT_LEVELS.items()):
        if event not in current:
            create[f"e{i}"] = {"event": event, "level": level}
        elif current[event].get("level") != level:
            update[current[event]["id"]] = {"level": level}
    if create or update:
        c.call("x:EventTracingLevel/set", {k: v for k, v in (("create", create), ("update", update)) if v})
        log(f"уровни событий: {', '.join(EVENT_LEVELS)}")
        changed = True
    return changed


def configure_service_account(c, domain_id):
    srv = read_env(SERVER_ENV)
    local = local_part(srv.get("STALWART_SERVICE_USER", ""), "svc")
    login = f"{local}@{DOMAIN}"
    perms = {"@type": "Merge", "enabledPermissions": {p: True for p in SERVICE_PERMISSIONS}, "disabledPermissions": {}}
    acc = find_account(c, local, domain_id)
    if acc is None:
        r = c.call("x:Account/set", {"create": {"s": {
            "@type": "User", "name": local, "domainId": domain_id, "roles": {"@type": "User"}, "permissions": perms,
            "description": "Tabora: служба tabora-server (только ключ API с 127.0.0.1)"}}})
        acc_id = r["created"]["s"]["id"]
        log(f"учётка tabora-server {login} создана")
        update_env(SERVER_ENV, {"STALWART_SERVICE_USER": login}, mode=0o640, group="tabora")
    else:
        acc_id = acc["id"]
        if acc.get("permissions") != perms or acc.get("roles") != {"@type": "User"}:
            c.call("x:Account/set", {"update": {acc_id: {"permissions": perms, "roles": {"@type": "User"}}}})
            log(f"учётка tabora-server {login}: права обновлены")
    key = srv.get("STALWART_API_KEY", "")
    if key and Client(bearer=key).ok("x:Domain/get", {"ids": [domain_id]}):
        if update_env(SERVER_ENV, {"STALWART_SERVICE_USER": login}, remove=("STALWART_ADMIN_USER", "STALWART_ADMIN_PASS"),
                      mode=0o640, group="tabora"):
            log("server.env: пароль администратора убран")
        return
    # новый ключ API: временный пароль (только с 127.0.0.1), вход им, ключ, пароль удаляется.
    # Старые ключи при этом пропадают (список учётных данных заменяется целиком).
    tmp_pw = new_secret(48)
    c.call("x:Account/set", {"update": {acc_id: {"credentials": password_cred(tmp_pw)}}})
    svc = Client(login, tmp_pw)
    r = svc.call("x:ApiKey/set", {"create": {"k": {"description": "tabora-server", "permissions": {"@type": "Inherit"},
                                                    "allowedIps": LOOPBACK}}})
    key = r["created"]["k"]["secret"]
    creds = c.call("x:Account/get", {"ids": [acc_id], "properties": ["credentials"]})["list"][0].get("credentials") or {}
    drop = {f"credentials/{k}": None for k, v in creds.items() if v.get("@type") == "Password"}
    if drop:
        c.call("x:Account/set", {"update": {acc_id: drop}})
    update_env(SERVER_ENV, {"STALWART_SERVICE_USER": login, "STALWART_API_KEY": key},
               remove=("STALWART_ADMIN_USER", "STALWART_ADMIN_PASS"), mode=0o640, group="tabora")
    if not Client(bearer=key).ok("x:Domain/get", {"ids": [domain_id]}):
        raise SystemExit("новый ключ API tabora-server не работает")
    log(f"ключ API tabora-server выпущен и записан в {SERVER_ENV}")


def write_nginx_map(c):
    """Все учётки с ролью не User или с добавленными правами: nginx не пускает их Basic-auth снаружи."""
    names = set()
    for a in c.get_all("Account"):
        roles = (a.get("roles") or {}).get("@type")
        perms = (a.get("permissions") or {}).get("@type", "Inherit")
        if a.get("name") and (roles != "User" or perms != "Inherit"):
            names.add(a["name"].lower())
    lines = ["# Создано infra/stalwart/configure.py: логины с правами сверх обычного пользователя.",
             '"~*(^|%)admin(@|%|$)" 1;', '"~*(^|%)recovery-" 1;']
    lines += [f'"~*(^|%){n}(@|%|$)" 1;' for n in sorted(names)]
    text = "\n".join(lines) + "\n"
    try:
        if open(NGINX_MAP).read() == text:
            return
    except FileNotFoundError:
        pass
    with open(NGINX_MAP + ".tmp", "w") as f:
        f.write(text)
    os.chmod(NGINX_MAP + ".tmp", 0o644)
    os.replace(NGINX_MAP + ".tmp", NGINX_MAP)
    log(f"nginx: логины администраторов ({len(names)}) запрещены снаружи")


def write_zone(c, domain_id):
    d = c.call("x:Domain/get", {"ids": [domain_id]})["list"][0]
    zone = d.get("dnsZoneFile") or ""
    if not zone:
        log("зоны DNS у домена нет; поля: " + ", ".join(sorted(d)))
        return
    try:
        if open(ZONE_FILE).read() == zone:
            return
    except FileNotFoundError:
        pass
    with open(ZONE_FILE, "w") as f:
        f.write(zone)
    os.chmod(ZONE_FILE, 0o644)
    log(f"DNS-записи домена записаны в {ZONE_FILE}")


def apply():
    c = admin_client()
    changed = configure_listeners(c)
    domain_id = ensure_domain(c)
    changed |= configure_system(c, domain_id)
    changed |= configure_tracing(c)
    configure_service_account(c, domain_id)
    write_nginx_map(c)
    write_zone(c, domain_id)
    if not changed:
        log("Stalwart: настройки уже заданы")
    return CHANGED if changed else 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "apply"
    if cmd == "admin-ok":
        try:
            return 0 if admin_client().ok() else 1
        except JmapError:
            return 1
    commands = {"recovery-on": recovery_on, "recovery-off": recovery_off, "bootstrap": bootstrap, "apply": apply}
    if cmd not in commands:
        raise SystemExit(__doc__)
    try:
        return commands[cmd]()
    except JmapError as e:
        raise SystemExit(f"Stalwart: {e}")


if __name__ == "__main__":
    sys.exit(main())
