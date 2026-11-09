# Сервер Tabora

Один сервер Hetzner (`ssh tabora`): почта (Stalwart), сайт tabora.app (nginx, статика из `site/`),
API аккаунтов и синхронизации (`tabora-server`, PostgreSQL).

## Сеть

- Сайт `tabora.app`/`www` и `api.tabora.app` только через Cloudflare Tunnel: nginx слушает
  `127.0.0.1:8081` без TLS (шифрует туннель), работает и до выпуска сертификатов.
- Наружу открыты только 22 и почтовый хост `mx.tabora.app`: 25, 465, 587, 993 и 443 (JMAP,
  автонастройка, MTA-STS). Порты 80 и 4190 закрыты: сертификаты выпускаются через DNS-01, Sieve
  доступен через JMAP.
- На голый IP и чужие имена nginx ничего не отдаёт (443 — отказ в TLS-рукопожатии, 8081 — `444`).
- Stalwart HTTP/JMAP только на `127.0.0.1:8080`; адрес клиента он берёт из `X-Forwarded-For`,
  который nginx заполняет `$remote_addr`.

| Что | Где |
|---|---|
| Развёртывание с ноутбука | `infra/deploy.sh setup` (идемпотентно, можно в любой момент), `site`, `tunnel`, `tls`, `dns` |
| Скрипты на сервере | `/usr/local/lib/tabora` (копия `infra/`, из неё работают хук certbot и таймеры) |
| Stalwart | `/opt/stalwart`: `bin/` (root, sha256 сверяется), `etc/config.json` (только хранилище RocksDB), `data/`; служба `stalwart`, журнал `journalctl -u stalwart` |
| Настройки Stalwart | JMAP-объекты `x:*` через `infra/stalwart/configure.py` |
| nginx | `infra/nginx/*`; почтовый хост включается, когда есть сертификат |
| tabora-server | `/opt/tabora/bin/tabora-server` (root), данные `/opt/tabora/data`, служба `tabora-server` |
| PostgreSQL | база `tabora`, роль `tabora`, строка подключения в `server.env` |
| Сайт | `/var/www/tabora.app` ← `site/` |

## Секреты (все в `/etc/tabora`, каталог `root:tabora 750`)

| Файл | Права | Что |
|---|---|---|
| `server.env` | `root:tabora 640` | для tabora-server: база, ключ подписи, `STALWART_API_KEY` (ключ API учётки `STALWART_SERVICE_USER`) |
| `stalwart-admin.env` | `root 600` | администратор Stalwart (`STALWART_ADMIN_USER`/`PASS`), вход только с 127.0.0.1 |
| `cloudflare.env` | `root 600` | `CF_ACCOUNT_ID`, `CF_ZONE_ID`, на время настройки `CF_API_TOKEN` |
| `certbot-cloudflare.ini` | `root 600` | токен certbot (только DNS) |
| `/etc/cloudflared/<id>.json` | `root 600` | учётные данные туннеля (службе передаются через `LoadCredential`) |

Файлы создаются с правами до записи; секреты не передаются в аргументах команд (`ps` их не видит).

## Ввод в строй

1. `infra/deploy.sh setup`.
2. Купить домен, добавить зону в Cloudflare, включить DNSSEC.
3. Создать в Cloudflare (My Profile › API Tokens › Create Custom Token) два токена:
   - **tabora-setup** — Account › Cloudflare Tunnel › Edit; Zone › DNS › Edit, зона только tabora.app.
     Временный: нужен `setup-tunnel.sh` и первому `dns.sh`.
   - **tabora-certbot** — Zone › DNS › Edit, зона только tabora.app. Постоянный: продление сертификатов
     и повторные `dns.sh`.
4. На сервере вписать значения в уже созданные файлы (редактором, не командой `echo` — токен попадёт
   в историю): `ssh tabora`, `nano /etc/tabora/cloudflare.env` (`CF_ACCOUNT_ID`, `CF_ZONE_ID`,
   `CF_API_TOKEN` = tabora-setup), `nano /etc/tabora/certbot-cloudflare.ini` (tabora-certbot).
5. `infra/deploy.sh tunnel` — туннель, CNAME сайта и API, служба `cloudflared`.
6. `infra/deploy.sh tls` — сертификат `mx`, `autoconfig`, `autodiscover`, `mta-sts` (DNS-01), nginx на 443,
   сертификат в Stalwart, хук продления. Имена сайта и API не выпускаются (им сертификат не нужен).
7. `infra/deploy.sh dns` — A/AAAA `mx`, MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, SRV, автонастройка.
8. PTR в Hetzner Console: IPv4 и IPv6 сервера → `mx.tabora.app`.
9. Удалить строку `CF_API_TOKEN` из `cloudflare.env` и отозвать токен tabora-setup в Cloudflare:
   туннелю он не нужен, `dns.sh` дальше работает с токеном certbot.
10. Через неделю без отчётов TLS-RPT перевести `infra/mta-sts/mta-sts.txt` в `mode: enforce`.

## Stalwart: учётки и доступ

- **Администратор** — учётка со случайным именем и ролью Admin, пароль из 48 символов,
  `allowedIps` только 127.0.0.1 и ::1: снаружи (IMAP, SMTP, JMAP через nginx) он не входит, nginx к
  тому же отвечает 403 на Basic-auth любого логина с правами сверх пользователя (`admin`, `recovery-*`,
  администратор, служебная учётка; список пишет `configure.py` в `/etc/nginx/tabora-privileged-logins.map`).
  Панель: `ssh -L 8080:127.0.0.1:8080 tabora`, затем http://127.0.0.1:8080/admin, логин и пароль из
  `stalwart-admin.env`.
- **tabora-server** — учётка с ролью User плюс `sysAccount{Get,Query,Create,Update,Destroy}`,
  `sysDomain{Get,Query}`: создание и удаление пользователей и их алиасов. Вход только ключом API
  (пароля у учётки нет), ключ работает только с 127.0.0.1/::1. Stalwart не даёт ей выдать права, которых у
  неё нет, и трогать учётки с большими правами (администратора). Ограничить домен в OSS-версии нельзя
  (тенанты — Enterprise), но домен один. Новый ключ: удалить `STALWART_API_KEY` из `server.env` и
  `deploy.sh setup` (старый ключ при этом отзывается).
- **Аварийный администратор** (`STALWART_RECOVERY_ADMIN`) обходит `allowedIps`, поэтому в
  `stalwart.env` его нет. Он появляется только на время создания постоянного администратора
  (`setup.sh` делает это сам, если `stalwart-admin.env` нет или пароль не подходит) и сразу убирается.

## Журналы, баны, обновления

- Stalwart пишет события в journald (`journalctl -u stalwart`), неудачные входы — `auth.failed`.
- fail2ban: `sshd`, `stalwart` (SMTP AUTH, IMAP, JMAP по журналу Stalwart), `tabora-jmap` (401/403 на
  `/jmap` в `access.log`), `nginx-http-auth`, `nginx-botsearch`, `recidive`. Проверка: `fail2ban-client status`.
- Встроенный автобан Stalwart: 100 неудачных входов за сутки с адреса — блокировка (`x:BlockedIp`);
  127.0.0.1 и ::1 не блокируются никогда.
- Ubuntu и `cloudflared` обновляются через unattended-upgrades, службы перезапускает needrestart,
  перезагрузка при необходимости в 04:30.
- Stalwart не обновляется сам: версия и sha256 архива закреплены в `setup.sh`. Раз в неделю
  `tabora-stalwart-release.timer` проверяет новый релиз и пишет напоминание в журнал и при входе по SSH.
  Обновление: сверить хеш архива с `.sigstore.json` релиза (`sigstore verify github --cert-identity
  https://github.com/stalwartlabs/stalwart/.github/workflows/ci.yml@refs/tags/<версия> …`), поменять
  `STALWART_VERSION` и `STALWART_SHA256`, `deploy.sh setup`.
- cloud-init после первичной настройки отключён (`/etc/cloud/cloud-init.disabled`): при перезагрузке
  он гонится с переименованием сетевого интерфейса и падает; сеть остаётся в `/etc/netplan/50-cloud-init.yaml`.
  Увеличенный в Hetzner диск расширять вручную: `growpart /dev/sda 1 && resize2fs /dev/sda1`.
- Службы stalwart, tabora-server, cloudflared ограничены systemd (`systemd-analyze security <служба>`:
  около 1.5); `/proc` смонтирован с `hidepid=invisible` (logind и polkit — в группе `proc`).
