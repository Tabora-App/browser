# Сервер Tabora

Один сервер Hetzner (`ssh tabora`): почта (Stalwart), сайт tabora.app (nginx, статика из `site/`),
API аккаунтов и синхронизации (`tabora-server`, PostgreSQL).

| Что | Где |
|---|---|
| Развёртывание с ноутбука | `infra/deploy.sh setup` (идемпотентно), `infra/deploy.sh site`, `infra/deploy.sh tls` |
| Stalwart | `/opt/stalwart` (бинарник, `etc/config.toml`, данные RocksDB), служба `stalwart`, HTTP/JMAP только на 127.0.0.1:8080 |
| nginx | `infra/nginx/*.conf`; до TLS включены `*.http.conf`, после `enable-tls.sh` боевые |
| tabora-server | `/opt/tabora/bin/tabora-server`, служба `tabora-server`, секреты `/etc/tabora/server.env` |
| PostgreSQL | база `tabora`, роль `tabora`, строка подключения в `server.env` |
| Сайт | `/var/www/tabora.app` ← `site/` |
| Пароль админа Stalwart | `/root/.stalwart-init.txt` и `STALWART_ADMIN_PASS` в `server.env` |

Порядок ввода в строй: `deploy.sh setup` → DNS домена (A/AAAA для tabora.app, www, mx, api, autoconfig,
autodiscover; MX, SPF, DKIM, DMARC из Stalwart) → PTR в консоли Hetzner → `deploy.sh tls` → домен в Stalwart.
