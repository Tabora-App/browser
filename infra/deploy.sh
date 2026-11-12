#!/usr/bin/env bash
# Развёртывание с ноутбука: копирует infra/ и site/ на сервер (/root/tabora-infra) и запускает
# нужный скрипт. Использование: infra/deploy.sh [setup|site|web|downloads|server|nginx|tls|tunnel|dns]
# `infra/deploy.sh dns --plan` показывает, какие записи DNS изменились бы, ничего не меняя.
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
  web)
    # Веб-версия (app.tabora.app): сборка на этой машине (tools/web/build.mjs, версии пакетов
    # закреплены) и выкладка в /var/www/app.<домен>. Сначала в соседний каталог, потом одной
    # командой на место: посетитель не застанет страницу со ссылками на ещё не доехавшие файлы.
    # Имя должно быть включено в nginx (сертификат: deploy.sh tls) и в DNS (deploy.sh dns).
    (cd "$ROOT/tools/web" && npm ci --ignore-scripts --no-audit --no-fund --silent && node build.mjs "$ROOT/.build/web")
    [ -f "$ROOT/.build/web/index.html" ] && [ -f "$ROOT/.build/web/build.json" ] || { echo "сборка веб-версии не получилась"; exit 1; }
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}; install -d -m 755 -o root -g root "/var/www/app.$DOMAIN" "/var/www/app.$DOMAIN.next"'
    rsync -az --delete "$ROOT/.build/web/" "$HOST:/var/www/app.${DOMAIN:-tabora.app}.next/"
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}
      rsync -a --delete --chown=root:root --chmod=D755,F644 "/var/www/app.$DOMAIN.next/" "/var/www/app.$DOMAIN/"
      rm -rf "/var/www/app.$DOMAIN.next"
      echo "веб-версия обновлена: $(python3 -c "import json; d = json.load(open(\"/var/www/app.$DOMAIN/build.json\")); print(\"версия\", d[\"version\"], \"файлов\", len(d[\"files\"]))")"'
    ;;
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
    # Перед заменой: копия базы в /var/backups/tabora (схему меняет сама служба при запуске) и
    # прежняя сборка рядом как tabora-server.prev. Если новая не ответила, прежняя возвращается
    # сама; изменения схемы только добавляют таблицы и столбцы, прежней сборке они не мешают.
    (cd "$ROOT/server" && cargo build --release --target x86_64-unknown-linux-musl)
    bin="$ROOT/server/target/x86_64-unknown-linux-musl/release/tabora-server"
    echo "локально: $(shasum -a 256 "$bin" | cut -d' ' -f1)"
    rsync -az "$bin" "$HOST:/root/tabora-infra/tabora-server.new"
    ssh "$HOST" 'set -e
      umask 077
      bin=/opt/tabora/bin/tabora-server
      alive() {
        for i in 1 2 3 4 5 6 7 8 9 10; do
          if curl -fsS -m 3 http://127.0.0.1:7700/v1/health; then echo; return 0; fi
          sleep 1
        done
        return 1
      }
      install -d -m 700 -o root -g root /var/backups/tabora
      dump=/var/backups/tabora/before-deploy.pgdump
      runuser -u postgres -- pg_dump -Fc tabora > $dump.new
      mv -f $dump.new $dump
      echo "копия базы: $dump ($(stat -c %s $dump) байт)"
      install -m 755 -o root -g root /root/tabora-infra/tabora-server.new $bin.new
      rm -f /root/tabora-infra/tabora-server.new
      [ ! -f $bin ] || cp -pf $bin $bin.prev
      mv -f $bin.new $bin
      echo "на сервере: $(sha256sum $bin | cut -d" " -f1)"
      systemctl daemon-reload
      systemctl enable tabora-server >/dev/null 2>&1
      systemctl restart tabora-server
      if alive; then echo "tabora-server работает"; exit 0; fi
      journalctl -u tabora-server -n 30 --no-pager
      if [ -f $bin.prev ]; then
        echo "новая сборка не отвечает — возвращаю прежнюю"
        cp -pf $bin.prev $bin.new && mv -f $bin.new $bin
        systemctl restart tabora-server
        if alive; then echo "прежняя сборка работает"; else echo "прежняя сборка тоже не отвечает"; fi
      fi
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
  dns)    if [ "${2:-}" = "--plan" ]; then ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/dns.sh --plan'; else ssh "$HOST" 'bash /root/tabora-infra/infra/cloudflare/dns.sh'; fi ;;
  *) echo "setup | site | web | downloads | server | nginx | tls | tunnel | dns"; exit 1 ;;
esac
