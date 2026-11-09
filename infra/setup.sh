#!/usr/bin/env bash
# Развёртывание сервера Tabora (Hetzner, Ubuntu 24/26). Идемпотентно: можно запускать повторно.
# Ставит: базовую защиту (ufw, fail2ban, swap, автообновления), nginx + certbot, PostgreSQL,
# Stalwart (почта), каркас сервиса tabora-server и каталог сайта. TLS включается отдельно
# скриптом enable-tls.sh после появления DNS-записей домена.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN=${DOMAIN:-tabora.app}
MAIL_HOST=${MAIL_HOST:-mx.$DOMAIN}
API_HOST=${API_HOST:-api.$DOMAIN}
STALWART_VERSION=${STALWART_VERSION:-v1.1.0}
HERE=$(cd "$(dirname "$0")" && pwd)

log() { printf '\033[1;32m›\033[0m %s\n' "$*"; }

# ---- система -----------------------------------------------------------------
log "система: пакеты"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ufw fail2ban unattended-upgrades nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib curl jq rsync sqlite3 dnsutils ca-certificates

hostnamectl set-hostname "$MAIL_HOST"
grep -q "$MAIL_HOST" /etc/hosts || echo "127.0.1.1 $MAIL_HOST mx" >> /etc/hosts

if ! swapon --show | grep -q swapfile; then
  log "система: swap 2 ГБ"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null; echo 'vm.swappiness=10' > /etc/sysctl.d/90-tabora.conf

log "система: автообновления безопасности"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF

log "система: журнал не больше 500 МБ"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

# ---- файрвол и fail2ban ------------------------------------------------------
log "файрвол"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in 22 80 443 25 465 587 993 4190; do ufw allow "$p/tcp" >/dev/null; done
ufw --force enable >/dev/null

log "fail2ban"
cat > /etc/fail2ban/jail.d/tabora.local <<'CONF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
CONF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

# ---- PostgreSQL --------------------------------------------------------------
log "PostgreSQL: база tabora"
mkdir -p /etc/tabora && chmod 750 /etc/tabora
if [ ! -f /etc/tabora/server.env ]; then
  DBPASS=$(openssl rand -hex 24)
  cat > /etc/tabora/server.env <<CONF
# Секреты сервиса tabora-server. Файл создан setup.sh, не коммитить.
TABORA_DOMAIN=$DOMAIN
TABORA_LISTEN=127.0.0.1:7700
TABORA_DB=postgres://tabora:$DBPASS@127.0.0.1:5432/tabora?sslmode=disable
TABORA_PUBLIC_URL=https://$API_HOST
STALWART_URL=http://127.0.0.1:8080
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASS=
APP_SIGNING_KEY=$(openssl rand -hex 32)
CONF
  chmod 640 /etc/tabora/server.env
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tabora') THEN
    CREATE ROLE tabora LOGIN PASSWORD '$DBPASS';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='tabora'" | grep -q 1 || sudo -u postgres createdb -O tabora tabora
fi
systemctl enable --now postgresql >/dev/null

# ---- Stalwart ----------------------------------------------------------------
log "Stalwart $STALWART_VERSION"
id -u stalwart >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/stalwart stalwart
mkdir -p /opt/stalwart/bin /opt/stalwart/etc /opt/stalwart/data /opt/stalwart/logs
if [ ! -x /opt/stalwart/bin/stalwart ] || ! /opt/stalwart/bin/stalwart --version 2>/dev/null | grep -q "${STALWART_VERSION#v}"; then
  curl -fsSL "https://github.com/stalwartlabs/stalwart/releases/download/$STALWART_VERSION/stalwart-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/stalwart.tgz
  tar -xzf /tmp/stalwart.tgz -C /opt/stalwart/bin
  chmod +x /opt/stalwart/bin/stalwart
  rm -f /tmp/stalwart.tgz
fi
# Stalwart 1.x: config.json описывает только хранилище, все настройки живут в базе и
# правятся через REST API (/api/settings) или веб-панель. Администратор задаётся в env.
if [ ! -f /opt/stalwart/etc/config.json ]; then
  cat > /opt/stalwart/etc/config.json <<'CONF'
{
  "@type": "RocksDb",
  "path": "/opt/stalwart/data",
  "blobSize": 16834,
  "bufferSize": 134217728,
  "poolWorkers": null
}
CONF
fi
if [ ! -f /opt/stalwart/etc/stalwart.env ]; then
  ADMINPASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 28)
  cat > /opt/stalwart/etc/stalwart.env <<CONF
STALWART_HOSTNAME=$MAIL_HOST
STALWART_PUBLIC_URL=https://$MAIL_HOST
STALWART_RECOVERY_ADMIN=admin:$ADMINPASS
CONF
  sed -i "s|^STALWART_ADMIN_PASS=.*|STALWART_ADMIN_PASS=$ADMINPASS|" /etc/tabora/server.env
fi
chown -R stalwart:stalwart /opt/stalwart
chown root:stalwart /opt/stalwart/etc/stalwart.env && chmod 640 /opt/stalwart/etc/stalwart.env
chmod 750 /opt/stalwart/etc /opt/stalwart/data /opt/stalwart/logs
cat > /etc/systemd/system/stalwart.service <<'CONF'
[Unit]
Description=Stalwart Mail Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=stalwart
Group=stalwart
EnvironmentFile=/opt/stalwart/etc/stalwart.env
ExecStart=/opt/stalwart/bin/stalwart --config=/opt/stalwart/etc/config.json
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/stalwart

[Install]
WantedBy=multi-user.target
CONF
systemctl daemon-reload
systemctl enable --now stalwart >/dev/null
systemctl restart stalwart
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8080/ && break; sleep 1; done
# настройки почтового сервера (слушатели, имя хоста) задаёт stalwart/configure.sh через API
python3 "$HERE/stalwart/configure.py"

# ---- tabora-server (каркас) --------------------------------------------------
log "tabora-server: пользователь и служба"
id -u tabora >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/tabora tabora
mkdir -p /opt/tabora/bin /opt/tabora/data && chown -R tabora:tabora /opt/tabora
chgrp tabora /etc/tabora /etc/tabora/server.env
cat > /etc/systemd/system/tabora-server.service <<'CONF'
[Unit]
Description=Tabora account and sync server
After=network-online.target postgresql.service stalwart.service
Wants=network-online.target

[Service]
Type=simple
User=tabora
Group=tabora
EnvironmentFile=/etc/tabora/server.env
ExecStart=/opt/tabora/bin/tabora-server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/tabora/data

[Install]
WantedBy=multi-user.target
CONF
systemctl daemon-reload
systemctl enable tabora-server >/dev/null 2>&1 || true
# запускать будет deploy.sh после загрузки бинарника

# ---- nginx + сайт ------------------------------------------------------------
log "nginx: сайт, почтовый хост, API (пока без TLS)"
mkdir -p /var/www/tabora.app /var/www/letsencrypt
[ -f /var/www/tabora.app/index.html ] || cp "$HERE/../site/index.html" /var/www/tabora.app/index.html
rsync -a --delete "$HERE/../site/" /var/www/tabora.app/
chown -R www-data:www-data /var/www/tabora.app
rm -f /etc/nginx/sites-enabled/default
for f in "$HERE"/nginx/*.http.conf; do
  name=$(basename "$f" .http.conf)
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__MAIL_HOST__/$MAIL_HOST/g" -e "s/__API_HOST__/$API_HOST/g" "$f" > "/etc/nginx/sites-available/$name"
  ln -sf "/etc/nginx/sites-available/$name" "/etc/nginx/sites-enabled/$name"
done
install -m 644 "$HERE/nginx/security.inc" /etc/nginx/snippets/tabora-security.conf
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

log "готово. Stalwart: $(/opt/stalwart/bin/stalwart --version 2>/dev/null | head -1); nginx: $(nginx -v 2>&1 | cut -d/ -f2); PostgreSQL: $(psql --version | awk '{print $3}')"
log "дальше: DNS домена → infra/enable-tls.sh"
