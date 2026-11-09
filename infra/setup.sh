#!/usr/bin/env bash
# Развёртывание сервера Tabora (Hetzner, Ubuntu 24/26). Идемпотентно: повторный запуск приводит
# сервер к тому же состоянию и ничего не откатывает (TLS, туннель, учётки Stalwart сохраняются).
# Ставит: базовую защиту (ufw, fail2ban, автообновления с перезагрузкой, hidepid), nginx, PostgreSQL,
# Stalwart (почта) с проверкой sha256, каркас службы tabora-server и сайт.
# TLS включает enable-tls.sh, туннель и DNS — cloudflare/setup-tunnel.sh и cloudflare/dns.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
umask 022

DOMAIN=${DOMAIN:-tabora.app}
MAIL_HOST=${MAIL_HOST:-mx.$DOMAIN}
API_HOST=${API_HOST:-api.$DOMAIN}
# Новая версия: поменять обе строки. Хеш архива сверен с .sigstore.json релиза (подпись
# GitHub Actions stalwartlabs/stalwart ci.yml@refs/tags/v1.1.0, проверено `sigstore verify github`).
STALWART_VERSION=${STALWART_VERSION:-v1.1.0}
STALWART_SHA256=${STALWART_SHA256:-62e6fdaf68f6ddfb45aa0dc1c28578a7e05f1e5e9a0c95fccfe1eae709d4ecbc}
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

# ---- система -----------------------------------------------------------------
log "система: пакеты"
apt-get update -q
apt-get -y -q --with-new-pkgs upgrade   # с новыми пакетами (ядро), без удаления
apt-get -y -q install ufw fail2ban python3-systemd unattended-upgrades needrestart nginx certbot \
  python3-certbot-dns-cloudflare postgresql postgresql-contrib curl jq rsync sqlite3 dnsutils ca-certificates openssl

if ! command -v cloudflared >/dev/null; then
  log "cloudflared: пакет из репозитория Cloudflare (обновляется через unattended-upgrades)"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y -q cloudflared
fi

hostnamectl set-hostname "$MAIL_HOST"
grep -q "$MAIL_HOST" /etc/hosts || echo "127.0.1.1 $MAIL_HOST mx" >> /etc/hosts

if ! swapon --show | grep -q swapfile; then
  log "система: swap 2 ГБ"
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -q -w vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-tabora.conf

log "система: автообновления (с перезагрузкой в 04:30 при необходимости), перезапуск служб после обновлений"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52tabora-unattended-upgrades <<'CONF'
// Tabora: дополнение к 50unattended-upgrades
// у репозитория cloudflared нет Suite (только Codename: any), поэтому шаблон, а не "origin:archive"
Unattended-Upgrade::Origins-Pattern { "origin=cloudflared,codename=any,label=cloudflared"; };
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
CONF
mkdir -p /etc/needrestart/conf.d
# без этого needrestart при автообновлении только перечисляет службы со старыми библиотеками
echo "\$nrconf{restart} = 'a';" > /etc/needrestart/conf.d/90-tabora.conf

# cloud-init после первичной настройки (сеть, ключи, имя) не нужен, а при перезагрузке гонится с
# переименованием сетевого интерфейса Hetzner (enp1s0 → eth0) и падает. Сетевая настройка остаётся в
# /etc/netplan/50-cloud-init.yaml. Вернуть: rm /etc/cloud/cloud-init.disabled (диск при увеличении
# в Hetzner без cloud-init расширяется вручную: growpart /dev/sda 1 && resize2fs /dev/sda1).
if [ -f /var/lib/cloud/instance/boot-finished ] && [ ! -f /etc/cloud/cloud-init.disabled ]; then
  log "система: cloud-init отключён после первичной настройки"
  touch /etc/cloud/cloud-init.disabled
  systemctl reset-failed 'cloud-init*' 2>/dev/null || true
fi

log "система: журнал не больше 500 МБ"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

log "система: /proc с hidepid (чужие процессы не видны службам и пользователям)"
getent group proc >/dev/null || groupadd -r proc
PROC_GID=$(getent group proc | cut -d: -f3)
PROC_OPTS="nosuid,nodev,noexec,relatime,hidepid=invisible,gid=$PROC_GID"
if grep -qE '^proc[[:space:]]+/proc[[:space:]]' /etc/fstab; then
  sed -i -E "s|^proc[[:space:]]+/proc[[:space:]].*|proc /proc proc $PROC_OPTS 0 0|" /etc/fstab
else
  echo "proc /proc proc $PROC_OPTS 0 0" >> /etc/fstab
fi
# logind (нет CAP_SYS_PTRACE) и polkit читают /proc чужих процессов: им группа proc
mkdir -p /etc/systemd/system/systemd-logind.service.d
printf '[Service]\nSupplementaryGroups=proc\n' > /etc/systemd/system/systemd-logind.service.d/tabora-hidepid.conf
if id polkitd >/dev/null 2>&1 && ! id -nG polkitd | grep -qw proc; then usermod -aG proc polkitd; systemctl try-restart polkit 2>/dev/null || true; fi
systemctl daemon-reload
findmnt -no OPTIONS /proc | grep -q "hidepid=invisible" || mount -o "remount,hidepid=invisible,gid=$PROC_GID" /proc

# ---- файрвол -------------------------------------------------------------------
log "файрвол: 22, почта (25/465/587/993) и 443 почтового хоста; 80 и 4190 закрыты"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in 22 25 443 465 587 993; do ufw allow "$p/tcp" >/dev/null; done
for p in 80 4190; do ufw delete allow "$p/tcp" >/dev/null 2>&1 || true; done
ufw --force enable >/dev/null

# ---- скрипты на сервере ------------------------------------------------------------
log "скрипты: $LIB (хук certbot, таймеры)"
install_lib "$HERE"

# ---- пользователи и секреты ----------------------------------------------------------
id -u tabora >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/tabora tabora
id -u stalwart >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/stalwart stalwart
install -d -m 750 -o root -g tabora /etc/tabora
# Cloudflare: файлы создаются пустыми с правами 600 до того, как в них что-то запишут (см. README)
[ -f /etc/tabora/cloudflare.env ] || cat > /etc/tabora/cloudflare.env <<'CONF'
# Cloudflare для cloudflare/setup-tunnel.sh и cloudflare/dns.sh (права 600, только root).
# CF_API_TOKEN: Account › Cloudflare Tunnel › Edit и Zone › DNS › Edit для зоны; после настройки
# туннеля и DNS строку с токеном удалить, а сам токен отозвать в панели Cloudflare.
CF_ACCOUNT_ID=
CF_ZONE_ID=
CF_API_TOKEN=
CONF
[ -f /etc/tabora/certbot-cloudflare.ini ] || cat > /etc/tabora/certbot-cloudflare.ini <<'CONF'
# Отдельный токен certbot: только Zone › DNS › Edit для зоны (DNS-01 и продление сертификатов).
dns_cloudflare_api_token =
CONF
chown root:root /etc/tabora/cloudflare.env /etc/tabora/certbot-cloudflare.ini
chmod 600 /etc/tabora/cloudflare.env /etc/tabora/certbot-cloudflare.ini
[ ! -f /etc/tabora/stalwart-admin.env ] || { chown root:root /etc/tabora/stalwart-admin.env; chmod 600 /etc/tabora/stalwart-admin.env; }

# ---- PostgreSQL --------------------------------------------------------------
log "PostgreSQL: роль и база tabora"
systemctl enable --now postgresql >/dev/null
if [ ! -f /etc/tabora/server.env ]; then
  ( umask 077
    cat > /etc/tabora/server.env.new <<CONF
# Секреты сервиса tabora-server. Файл создан setup.sh, не коммитить.
TABORA_DOMAIN=$DOMAIN
TABORA_LISTEN=127.0.0.1:7700
TABORA_DB=postgres://tabora:$(openssl rand -hex 24)@127.0.0.1:5432/tabora?sslmode=disable
TABORA_PUBLIC_URL=https://$API_HOST
STALWART_URL=http://127.0.0.1:8080
APP_SIGNING_KEY=$(openssl rand -hex 32)
CONF
  )
  mv /etc/tabora/server.env.new /etc/tabora/server.env
fi
chown root:tabora /etc/tabora/server.env && chmod 640 /etc/tabora/server.env
# роль и база проверяются по отдельности при каждом запуске: сбой посередине не оставляет полдела
DBPASS=$(sed -n 's|^TABORA_DB=postgres://tabora:\([0-9a-f]*\)@.*|\1|p' /etc/tabora/server.env)
[ -n "$DBPASS" ] || die "не разобрать пароль базы в TABORA_DB (/etc/tabora/server.env)"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='tabora'" | grep -q 1; then
  # пароль идёт через stdin (printf — встроенная команда), а не в аргументах psql
  printf "CREATE ROLE tabora LOGIN PASSWORD '%s';\n" "$DBPASS" | sudo -u postgres psql -v ON_ERROR_STOP=1 -q
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='tabora'" | grep -q 1 || sudo -u postgres createdb -O tabora tabora
unset DBPASS

# ---- Stalwart ----------------------------------------------------------------
log "Stalwart $STALWART_VERSION"
install -d -m 755 -o root -g root /opt/stalwart /opt/stalwart/bin
install -d -m 750 -o root -g stalwart /opt/stalwart/etc
install -d -m 750 -o stalwart -g stalwart /opt/stalwart/data /opt/stalwart/logs
# бинарник принадлежит root (служба не может его подменить); хеш бинарника из проверенного архива
# хранится рядом и сверяется при каждом запуске
want_bin_hash=$(cat /opt/stalwart/bin/stalwart.sha256 2>/dev/null || true)
have_bin_hash=$( [ -f /opt/stalwart/bin/stalwart ] && sha256sum /opt/stalwart/bin/stalwart | cut -d' ' -f1 || true)
if [ "$(cat /opt/stalwart/bin/archive.sha256 2>/dev/null || true)" != "$STALWART_SHA256" ] || [ -z "$want_bin_hash" ] || [ "$want_bin_hash" != "$have_bin_hash" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/stalwartlabs/stalwart/releases/download/$STALWART_VERSION/stalwart-x86_64-unknown-linux-gnu.tar.gz" -o "$tmp/stalwart.tgz"
  echo "$STALWART_SHA256  $tmp/stalwart.tgz" | sha256sum -c --quiet - || { rm -rf "$tmp"; die "sha256 архива Stalwart не совпадает"; }
  tar -xzf "$tmp/stalwart.tgz" -C "$tmp" stalwart
  install -m 755 -o root -g root "$tmp/stalwart" /opt/stalwart/bin/stalwart.new
  mv -f /opt/stalwart/bin/stalwart.new /opt/stalwart/bin/stalwart
  sha256sum /opt/stalwart/bin/stalwart | cut -d' ' -f1 > /opt/stalwart/bin/stalwart.sha256
  echo "$STALWART_SHA256" > /opt/stalwart/bin/archive.sha256
  rm -rf "$tmp"
  STALWART_INSTALLED=1
fi
chown root:root /opt/stalwart/bin/* && chmod 755 /opt/stalwart/bin/stalwart && chmod 644 /opt/stalwart/bin/*.sha256
# Stalwart 1.x: config.json описывает только хранилище, всё остальное — JMAP-объекты (stalwart/configure.py)
[ -f /opt/stalwart/etc/config.json ] || cat > /opt/stalwart/etc/config.json <<'CONF'
{
  "@type": "RocksDb",
  "path": "/opt/stalwart/data",
  "blobSize": 16834,
  "bufferSize": 134217728,
  "poolWorkers": null
}
CONF
[ -f /opt/stalwart/etc/stalwart.env ] || printf 'STALWART_HOSTNAME=%s\nSTALWART_PUBLIC_URL=https://%s\n' "$MAIL_HOST" "$MAIL_HOST" > /opt/stalwart/etc/stalwart.env
rm -f /opt/stalwart/etc/config.toml.tabora /root/.stalwart-init.txt   # остатки старой схемы (TOML, init)
chown root:stalwart /opt/stalwart/etc/config.json /opt/stalwart/etc/stalwart.env
chmod 640 /opt/stalwart/etc/config.json /opt/stalwart/etc/stalwart.env
chown -R stalwart:stalwart /opt/stalwart/data /opt/stalwart/logs
render "$HERE/systemd/stalwart.service" /etc/systemd/system/stalwart.service
[ -z "$RENDER_CHANGED" ] || STALWART_INSTALLED=1
systemctl daemon-reload
systemctl enable stalwart >/dev/null 2>&1

stalwart_restart() {
  systemctl restart stalwart
  for _ in $(seq 1 60); do
    case "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/jmap/session)" in 2??|401) return 0 ;; esac
    sleep 1
  done
  die "Stalwart не отвечает на 127.0.0.1:8080"
}
# перезапуск только при новом бинарнике или юните (или если служба не работает)
if [ -n "${STALWART_INSTALLED:-}" ] || ! systemctl is-active -q stalwart; then stalwart_restart; fi

CONFIGURE="python3 $LIB/stalwart/configure.py"
if ! $CONFIGURE admin-ok; then
  log "Stalwart: постоянного администратора нет — создаётся через временного аварийного"
  $CONFIGURE recovery-on || [ $? -eq 3 ]
  stalwart_restart
  $CONFIGURE bootstrap
fi
# аварийный администратор (STALWART_RECOVERY_ADMIN) обходит allowedIps, поэтому в env его нет
rc=0; $CONFIGURE recovery-off || rc=$?
[ $rc -eq 0 ] || [ $rc -eq 3 ] || exit $rc
[ $rc -eq 0 ] || stalwart_restart
rc=0; $CONFIGURE apply || rc=$?
[ $rc -eq 0 ] || [ $rc -eq 3 ] || exit $rc
[ $rc -eq 0 ] || { log "Stalwart: перезапуск, чтобы применить настройки"; stalwart_restart; }
if tls_enabled; then
  python3 "$LIB/stalwart/upload-cert.py" "$MX_LIVE" >/dev/null
  install_certbot_hook "$HERE"
fi

# ---- tabora-server (каркас) --------------------------------------------------
log "tabora-server: пользователь и служба"
install -d -m 755 -o root -g root /opt/tabora /opt/tabora/bin
install -d -m 750 -o tabora -g tabora /opt/tabora/data
[ ! -e /opt/tabora/bin/tabora-server ] || chown root:root /opt/tabora/bin/tabora-server
render "$HERE/systemd/tabora-server.service" /etc/systemd/system/tabora-server.service
systemctl daemon-reload
systemctl enable tabora-server >/dev/null 2>&1 || true
# запускать будет deploy.sh после загрузки бинарника
[ ! -x /opt/tabora/bin/tabora-server ] || systemctl try-restart tabora-server

# ---- проверка новых версий Stalwart (сам Stalwart не обновляется: версия и хеш закреплены) ----
render "$HERE/systemd/tabora-stalwart-release.service" /etc/systemd/system/tabora-stalwart-release.service
render "$HERE/systemd/tabora-stalwart-release.timer" /etc/systemd/system/tabora-stalwart-release.timer
install -m 755 "$HERE/stalwart/motd.sh" /etc/update-motd.d/95-tabora-stalwart
systemctl daemon-reload
systemctl enable --now tabora-stalwart-release.timer >/dev/null 2>&1

# ---- nginx + сайт ------------------------------------------------------------
log "сайт: /var/www/tabora.app"
mkdir -p /var/www/tabora.app /var/www/mta-sts/.well-known
install -m 644 "$HERE/mta-sts/mta-sts.txt" /var/www/mta-sts/.well-known/mta-sts.txt
rsync -a --delete "$HERE/../site/" /var/www/tabora.app/
chown -R www-data:www-data /var/www/tabora.app
install_nginx "$HERE/nginx"

# ---- fail2ban ------------------------------------------------------------------
log "fail2ban: ssh, nginx, JMAP (401/403), Stalwart (SMTP AUTH, IMAP, JMAP по журналу)"
install -m 644 "$HERE"/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
install -m 644 "$HERE/fail2ban/tabora.local" /etc/fail2ban/jail.d/tabora.local
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
for _ in $(seq 1 20); do fail2ban-client ping >/dev/null 2>&1 && break; sleep 1; done
fail2ban-client status | sed -n 's/.*Jail list:[[:space:]]*/  jail: /p'

log "готово. Stalwart: $(/opt/stalwart/bin/stalwart --version 2>/dev/null | head -1); nginx: $(nginx -v 2>&1 | cut -d/ -f2); PostgreSQL: $(psql --version | awk '{print $3}')"
if tls_enabled; then log "TLS включён ($MAIL_HOST)"; else log "дальше: домен в Cloudflare → infra/deploy.sh tunnel → tls → dns (infra/README.md)"; fi
[ ! -f /var/run/reboot-required ] || log "нужна перезагрузка: $(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null)"
