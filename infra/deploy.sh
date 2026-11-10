#!/usr/bin/env bash
# Развёртывание с ноутбука: копирует infra/ и site/ на сервер (/root/tabora-infra) и запускает
# нужный скрипт. Использование: infra/deploy.sh [setup|site|downloads|tls|tunnel|dns]
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
  downloads)
    # Установщики из .build/signed → /var/www/downloads (nginx отдаёт как /downloads/). Старые версии
    # на сервере не удаляются. В конце печатает sha256 с сервера: сверьте с суммой на сайте.
    shopt -s nullglob
    files=("$ROOT"/.build/signed/*.dmg)
    shopt -u nullglob
    [ ${#files[@]} -gt 0 ] || { echo "нет файлов .build/signed/*.dmg"; exit 1; }
    echo "локально:"; shasum -a 256 "${files[@]}"
    ssh "$HOST" 'install -d -m 755 -o root -g root /var/www/downloads'
    rsync -az --progress "${files[@]}" "$HOST:/var/www/downloads/"
    ssh "$HOST" 'cd /var/www/downloads && chown root:root -- *.dmg && chmod 644 -- *.dmg && echo "на сервере:" && sha256sum -- *.dmg'
    ;;
  tls)    ssh "$HOST" 'bash /root/tabora-infra/infra/enable-tls.sh' ;;
  tunnel) ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/setup-tunnel.sh' ;;
  dns)    ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/dns.sh' ;;
  *) echo "setup | site | downloads | tls | tunnel | dns"; exit 1 ;;
esac
