#!/usr/bin/env bash
# Включение TLS после появления DNS: сертификаты Let's Encrypt для сайта и почтового хоста,
# боевые конфиги nginx, сертификат для Stalwart. Запускать на сервере: bash infra/enable-tls.sh
set -euo pipefail
DOMAIN=${DOMAIN:-tabora.app}
MAIL_HOST=${MAIL_HOST:-mx.$DOMAIN}
API_HOST=${API_HOST:-api.$DOMAIN}
EMAIL=${EMAIL:-postmaster@$DOMAIN}
HERE=$(cd "$(dirname "$0")" && pwd)
log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }

. /etc/tabora/cloudflare.env
install -m 600 /dev/null /etc/tabora/certbot-cloudflare.ini
echo "dns_cloudflare_api_token = $CF_API_TOKEN" > /etc/tabora/certbot-cloudflare.ini
apt-get install -y -q python3-certbot-dns-cloudflare >/dev/null

log "сертификат сайта и API (DNS-01 через Cloudflare, за туннелем он нужен nginx для единообразия)"
certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/tabora/certbot-cloudflare.ini -d "$DOMAIN" -d "www.$DOMAIN" -d "$API_HOST" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
log "сертификат почтового хоста"
certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/tabora/certbot-cloudflare.ini -d "$MAIL_HOST" -d "autoconfig.$DOMAIN" -d "autodiscover.$DOMAIN" -d "mta-sts.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring

log "nginx: боевые конфиги"
install -m 644 "$HERE/nginx/proxy.inc" /etc/nginx/snippets/tabora-proxy.conf
rm -f /etc/nginx/sites-enabled/tabora.app /etc/nginx/sites-enabled/mx
# снаружи остаётся только 443 почтового хоста; 80 закрываем
ufw delete allow 80/tcp >/dev/null 2>&1 || true
for name in tabora.app mx api; do
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__MAIL_HOST__/$MAIL_HOST/g" -e "s/__API_HOST__/$API_HOST/g" "$HERE/nginx/$name.conf" > "/etc/nginx/sites-available/$name"
  ln -sf "/etc/nginx/sites-available/$name" "/etc/nginx/sites-enabled/$name"
done
nginx -t && systemctl reload nginx

log "Stalwart: сертификат почтового хоста"
# Stalwart хранит сертификат в своей базе: загружаем PEM и назначаем по умолчанию; хук certbot повторяет это при обновлении
python3 "$HERE/stalwart/upload-cert.py" "/etc/letsencrypt/live/$MAIL_HOST"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/tabora.sh <<HOOK
#!/bin/sh
systemctl reload nginx
python3 /root/tabora-infra/infra/stalwart/upload-cert.py /etc/letsencrypt/live/$MAIL_HOST
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/tabora.sh
log "готово: https://$DOMAIN, https://$MAIL_HOST/jmap, https://$API_HOST"
