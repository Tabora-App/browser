#!/usr/bin/env bash
# Развёртывание с ноутбука: копирует infra/ и site/ на сервер (/root/tabora-infra) и запускает
# нужный скрипт. Использование: infra/deploy.sh [setup|site|tls|tunnel|dns]
set -euo pipefail
HOST=${HOST:-tabora}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
what=${1:-setup}
ssh "$HOST" "install -d -m 700 /root/tabora-infra && mkdir -p /root/tabora-infra/infra /root/tabora-infra/site"
rsync -az --delete "$ROOT/infra/" "$HOST:/root/tabora-infra/infra/"
rsync -az --delete "$ROOT/site/" "$HOST:/root/tabora-infra/site/"
case "$what" in
  setup)  ssh "$HOST" 'bash /root/tabora-infra/infra/setup.sh' ;;
  site)   ssh "$HOST" 'rsync -a --delete --chown=root:root --chmod=D755,F644 /root/tabora-infra/site/ /var/www/tabora.app/ && echo "сайт обновлён"' ;;
  tls)    ssh "$HOST" 'bash /root/tabora-infra/infra/enable-tls.sh' ;;
  tunnel) ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/setup-tunnel.sh' ;;
  dns)    ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/dns.sh' ;;
  *) echo "setup | site | tls | tunnel | dns"; exit 1 ;;
esac
