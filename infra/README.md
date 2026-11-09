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

Сеть: сайт и API только через Cloudflare Tunnel (`infra/cloudflare/setup-tunnel.sh`, nginx на 127.0.0.1:8081), почтовые DNS-записи публикует `infra/cloudflare/dns.sh`; наружу открыт только почтовый хост (25/465/587/993/4190 и 443 для JMAP). Сертификаты через DNS-01 Cloudflare. Секреты Cloudflare в `/etc/tabora/cloudflare.env` (CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID).

Порядок ввода в строй: `deploy.sh setup` → домен в Cloudflare, `/etc/tabora/cloudflare.env` → `cloudflare/setup-tunnel.sh` (сайт, API) → `cloudflare/dns.sh` (почта) → PTR в Hetzner → `deploy.sh tls`.
