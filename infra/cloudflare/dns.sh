#!/usr/bin/env bash
# Публикация почтовых DNS-записей в Cloudflare из зоны Stalwart (/etc/tabora/dns-<домен>.zone)
# и адресных записей почтового хоста. Только mx без прокси (серое облако): SMTP/IMAP через прокси не ходят.
set -euo pipefail
DOMAIN=${DOMAIN:-tabora.app}
MAIL_HOST=${MAIL_HOST:-mx.$DOMAIN}
. /etc/tabora/cloudflare.env
IP4=$(curl -s -4 ifconfig.me); IP6=$(curl -s -6 ifconfig.me || true)
log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
cf() { curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }
upsert() { # type name content [priority]
  local type=$1 name=$2 content=$3 prio=${4:-}
  local extra=""; [ -n "$prio" ] && extra=",\"priority\":$prio"
  local rid; rid=$(cf "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=$type&name=$name" | jq -r --arg c "$content" '.result[] | select(.type!="TXT" or .content==$c or true) | .id' | head -1)
  local body; body=$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" "{type:\$t,name:\$n,content:\$c,proxied:false,ttl:3600$extra}")
  if [ -n "$rid" ] && [ "$type" != "TXT" ]; then cf -X PUT "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$rid" -d "$body" >/dev/null
  else
    # TXT может быть несколько на одном имени (DKIM-селекторы разные имена, SPF одно): для TXT ищем точное совпадение
    local same; same=$(cf "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=TXT&name=$name" | jq -r --arg c "$content" '.result[] | select(.content==$c) | .id' | head -1)
    [ -n "$same" ] || cf -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" -d "$body" >/dev/null
  fi
  log "$type $name"
}
upsert A "$MAIL_HOST" "$IP4"
[ -n "$IP6" ] && upsert AAAA "$MAIL_HOST" "$IP6"
# зона Stalwart: склеиваем многострочные TXT в скобках
python3 - "$DOMAIN" /etc/tabora/dns-$DOMAIN.zone <<'PY' | while IFS=$'\t' read -r type name content prio; do upsert "$type" "$name" "$content" "$prio"; done
import re, sys
domain, path = sys.argv[1], sys.argv[2]
text = open(path).read()
text = re.sub(r'\(\s*((?:"[^"]*"\s*)+)\)', lambda m: '"' + ''.join(re.findall(r'"([^"]*)"', m.group(1))) + '"', text, flags=re.S)
for line in text.splitlines():
    m = re.match(r'^(\S+?)\.\s+IN\s+(\w+)\s+(.*)$', line.strip())
    if not m: continue
    name, rtype, rest = m.groups()
    if rtype == 'TXT':
        print(f"TXT\t{name}\t{re.findall(r'\"([^\"]*)\"', rest)[0]}\t")
    elif rtype == 'MX':
        prio, host = rest.split(); print(f"MX\t{name}\t{host.rstrip('.')}\t{prio}")
    elif rtype == 'CNAME':
        print(f"CNAME\t{name}\t{rest.rstrip('.')}\t")
    elif rtype == 'SRV':
        pass  # SRV добавляются отдельно вручную при необходимости (Cloudflare требует поля service/proto)
PY
log "готово. Проверьте DNSSEC в панели Cloudflare (одна кнопка) и PTR в Hetzner: $MAIL_HOST"
