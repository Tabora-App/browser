#!/usr/bin/env bash
# Cloudflare Tunnel для сайта и API: у tabora.app, www и api нет публичного адреса, трафик идёт
# исходящим соединением сервера к Cloudflare. Наружу открыта только почта (mx.tabora.app).
# Нужны переменные (в /etc/tabora/cloudflare.env): CF_API_TOKEN (права: Zone.DNS Edit, Account.Cloudflare Tunnel Edit),
# CF_ACCOUNT_ID, CF_ZONE_ID. Идемпотентно.
set -euo pipefail
DOMAIN=${DOMAIN:-tabora.app}
API_HOST=${API_HOST:-api.$DOMAIN}
TUNNEL_NAME=${TUNNEL_NAME:-tabora}
. /etc/tabora/cloudflare.env
log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
cf() { curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }

if ! command -v cloudflared >/dev/null; then
  log "cloudflared: установка"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y -q cloudflared
fi

log "туннель $TUNNEL_NAME"
TUNNEL_ID=$(cf "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty')
if [ -z "$TUNNEL_ID" ]; then
  SECRET=$(openssl rand -base64 32)
  TUNNEL_ID=$(cf -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel" -d "{\"name\":\"$TUNNEL_NAME\",\"tunnel_secret\":\"$SECRET\",\"config_src\":\"cloudflare\"}" | jq -r '.result.id')
  mkdir -p /etc/cloudflared
  printf '{"AccountTag":"%s","TunnelSecret":"%s","TunnelID":"%s"}\n' "$CF_ACCOUNT_ID" "$SECRET" "$TUNNEL_ID" > /etc/cloudflared/$TUNNEL_ID.json
  chmod 600 /etc/cloudflared/$TUNNEL_ID.json
  log "туннель создан: $TUNNEL_ID"
else
  log "туннель уже есть: $TUNNEL_ID"
  [ -f /etc/cloudflared/$TUNNEL_ID.json ] || { echo "нет файла учётных данных /etc/cloudflared/$TUNNEL_ID.json: удалите туннель в Cloudflare и запустите снова"; exit 1; }
fi

log "маршруты туннеля (ingress) → nginx на 127.0.0.1:8081"
cf -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" -d @- >/dev/null <<JSON
{"config":{"ingress":[
  {"hostname":"$DOMAIN","service":"http://127.0.0.1:8081","originRequest":{"httpHostHeader":"$DOMAIN"}},
  {"hostname":"www.$DOMAIN","service":"http://127.0.0.1:8081","originRequest":{"httpHostHeader":"www.$DOMAIN"}},
  {"hostname":"$API_HOST","service":"http://127.0.0.1:8081","originRequest":{"httpHostHeader":"$API_HOST"}},
  {"service":"http_status:404"}
]}}
JSON

log "DNS: CNAME на туннель для $DOMAIN, www, $API_HOST (с прокси)"
for name in "$DOMAIN" "www.$DOMAIN" "$API_HOST"; do
  rid=$(cf "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$name" | jq -r '.result[0].id // empty')
  body="{\"type\":\"CNAME\",\"name\":\"$name\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
  if [ -n "$rid" ]; then cf -X PUT "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$rid" -d "$body" >/dev/null; else cf -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" -d "$body" >/dev/null; fi
done

log "служба cloudflared"
cat > /etc/cloudflared/config.yml <<CONF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
no-autoupdate: true
CONF
cloudflared service install 2>/dev/null || true
systemctl enable --now cloudflared >/dev/null
systemctl restart cloudflared
sleep 3; systemctl is-active cloudflared && log "туннель работает: https://$DOMAIN, https://$API_HOST"
