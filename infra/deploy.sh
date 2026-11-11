#!/usr/bin/env bash
# Развёртывание с ноутбука: копирует infra/ и site/ на сервер (/root/tabora-infra) и запускает
# нужный скрипт. Использование: infra/deploy.sh [setup|site|downloads|server|nginx|tls|tunnel|dns]
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
  server)
    # tabora-server: сборка на этой машине под сервер (Linux x86_64, статически; нужна цель Rust
    # x86_64-unknown-linux-musl), установка в /opt/tabora/bin с заменой одним переименованием,
    # перезапуск службы и проверка, что она отвечает. Настройки — /etc/tabora/server.env.
    (cd "$ROOT/server" && cargo build --release --target x86_64-unknown-linux-musl)
    bin="$ROOT/server/target/x86_64-unknown-linux-musl/release/tabora-server"
    echo "локально: $(shasum -a 256 "$bin" | cut -d' ' -f1)"
    rsync -az "$bin" "$HOST:/root/tabora-infra/tabora-server.new"
    ssh "$HOST" 'set -e
      install -m 755 -o root -g root /root/tabora-infra/tabora-server.new /opt/tabora/bin/tabora-server.new
      mv -f /opt/tabora/bin/tabora-server.new /opt/tabora/bin/tabora-server
      rm -f /root/tabora-infra/tabora-server.new
      echo "на сервере: $(sha256sum /opt/tabora/bin/tabora-server | cut -d" " -f1)"
      systemctl daemon-reload
      systemctl enable tabora-server >/dev/null 2>&1
      systemctl restart tabora-server
      for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -fsS -m 3 http://127.0.0.1:7700/v1/health; then echo; echo "tabora-server работает"; exit 0; fi
        sleep 1
      done
      journalctl -u tabora-server -n 20 --no-pager
      exit 1'
    ;;
  nginx)
    # только настройки nginx (после правки infra/nginx): проверка nginx -t и перечитывание без простоя
    ssh "$HOST" 'set -euo pipefail
      DOMAIN=${DOMAIN:-tabora.app}; MAIL_HOST=${MAIL_HOST:-mx.$DOMAIN}; API_HOST=${API_HOST:-api.$DOMAIN}
      . /root/tabora-infra/infra/lib.sh
      install_nginx /root/tabora-infra/infra/nginx
      echo "nginx: настройки обновлены"'
    ;;
  tls)    ssh "$HOST" 'bash /root/tabora-infra/infra/enable-tls.sh' ;;
  tunnel) ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/setup-tunnel.sh' ;;
  dns)    ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/dns.sh' ;;
  *) echo "setup | site | downloads | server | tls | tunnel | dns"; exit 1 ;;
esac
