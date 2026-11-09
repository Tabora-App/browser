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

for h in $DOMAIN www.$DOMAIN $MAIL_HOST $API_HOST autoconfig.$DOMAIN; do
  ip=$(dig +short A "$h" | tail -1)
  [ "$ip" = "$(curl -s -4 ifconfig.me)" ] || { echo "DNS для $h не указывает на этот сервер (сейчас: ${ip:-нет записи})"; exit 1; }
done

log "сертификат сайта"
certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
log "сертификат почты и API"
certbot certonly --webroot -w /var/www/letsencrypt -d "$MAIL_HOST" -d "$API_HOST" -d "autoconfig.$DOMAIN" -d "autodiscover.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring

log "nginx: боевые конфиги"
install -m 644 "$HERE/nginx/proxy.inc" /etc/nginx/snippets/tabora-proxy.conf
rm -f /etc/nginx/sites-enabled/tabora.app /etc/nginx/sites-enabled/mx
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
