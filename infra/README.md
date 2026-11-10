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
| Сайт | `/var/www/tabora.app` ← `site/` (владелец root, nginx только читает) |
| Резервные копии | `infra/backup/*`, таймеры `tabora-backup`, `tabora-backup-check`; состояние `/var/lib/tabora/backup.json` |
| Мониторинг | `infra/monitor/health.py`, таймер `tabora-health` (5 минут), `/run/tabora/health.json`, motd |
| Сеть | `/etc/netplan/50-tabora.yaml` ← `infra/network/netplan.py`, служба `tabora-network` |

## Секреты (все в `/etc/tabora`, каталог `root:tabora 750`)

| Файл | Права | Что |
|---|---|---|
| `server.env` | `root:tabora 640` | для tabora-server: база, ключ подписи, `STALWART_API_KEY` (ключ API учётки `STALWART_SERVICE_USER`) |
| `stalwart-admin.env` | `root 600` | администратор Stalwart (`STALWART_ADMIN_USER`/`PASS`), вход только с 127.0.0.1 |
| `cloudflare.env` | `root 600` | `CF_ACCOUNT_ID`, `CF_ZONE_ID`, на время настройки `CF_API_TOKEN` |
| `certbot-cloudflare.ini` | `root 600` | токен certbot: только Zone › DNS › Edit и только зона tabora.app (не «All zones», без прав на аккаунт); права файла выставляют `setup.sh` и `enable-tls.sh` при каждом запуске |
| `backup.env` | `root 600` | `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` (и ключи S3). **Пароль хранить и вне сервера** |
| `backup_ed25519(.pub)` | `root 600` / `644` | ключ SSH для sftp-хранилища копий (не в `~/.ssh`) |
| `alert.env` | `root 600` | `ALERT_URL`, `ALERT_FORMAT`, `ALERT_TOKEN` — оповещения мониторинга |
| `postmaster.env` | `root 600` | логин и пароль ящика `postmaster@` (алиасы `abuse@`, `hostmaster@`, `security@`, `webmaster@`, `hello@`) |
| `/etc/cloudflared/<id>.json` | `root 600` | учётные данные туннеля (службе передаются через `LoadCredential`) |

Файлы создаются с правами до записи; секреты не передаются в аргументах команд (`ps` их не видит).

## Ввод в строй

Сделано 10 ноября 2026: домен `tabora.app` зарегистрирован в Namesilo (автопродление, данные владельца
скрыты), зона в Cloudflare (серверы имён `emerie` и `norm`), DNSSEC включён (DS передан регистратору),
сертификат почтового хоста выпущен, почтовые записи опубликованы, почта ходит в обе стороны. Порядок
на случай повторения:

1. `infra/deploy.sh setup`.
2. Купить домен, добавить зону в Cloudflare, прописать у регистратора выданные Cloudflare серверы имён.
   После активации зоны включить DNSSEC и передать регистратору запись DS из Cloudflare.
3. Создать в Cloudflare два токена (My Profile › API Tokens › Create Custom Token или `POST /user/tokens`):
   - **tabora-setup** — Account › Cloudflare Tunnel › Edit; Zone › DNS › Edit, зона только tabora.app.
     Временный (срок сутки): нужен `setup-tunnel.sh` и первому `dns.sh`.
   - **tabora-certbot** — Zone › DNS › Edit, зона только tabora.app. Постоянный: продление сертификатов
     и повторные `dns.sh`.

   Обоим токенам задано условие «только с адресов сервера» (Client IP Address Filtering: IPv4 и /64
   IPv6): с другой машины они не работают. После переезда на новый адрес токен certbot выпустить заново.
4. На сервере вписать значения в уже созданные файлы (редактором или через stdin, не командой `echo` —
   токен попадёт в историю): `/etc/tabora/cloudflare.env` (`CF_ACCOUNT_ID`, `CF_ZONE_ID`,
   `CF_API_TOKEN` = tabora-setup), `/etc/tabora/certbot-cloudflare.ini` (tabora-certbot).
5. `infra/deploy.sh tunnel` — туннель, CNAME сайта и API, служба `cloudflared`.
6. `infra/deploy.sh tls` — сертификат `mx`, `autoconfig`, `autodiscover`, `mta-sts` (DNS-01), nginx на 443,
   сертификат в Stalwart, хук продления. Имена сайта и API не выпускаются (им сертификат не нужен).
7. `infra/deploy.sh dns` — A/AAAA `mx`, MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, SRV, автонастройка.
8. `infra/deploy.sh site` и `infra/deploy.sh downloads` — сайт и установщик из `.build/signed`.
9. PTR в Hetzner Console: IPv4 и IPv6 сервера → `mx.tabora.app`. У IPv6 записи по умолчанию нет вовсе,
   а без неё Gmail и другие отклоняют письма с этого адреса (исходящая почта идёт сначала по IPv4).
10. Удалить строку `CF_API_TOKEN` из `cloudflare.env` и отозвать токен tabora-setup в Cloudflare:
    туннелю он не нужен, `dns.sh` дальше работает с токеном certbot.
11. Через неделю без отчётов TLS-RPT перевести `infra/mta-sts/mta-sts.txt` в `mode: enforce`.

Настройки зоны в Cloudflare: Always Use HTTPS, минимальный TLS 1.2, режим SSL «Full (strict)».
Проверка доставки: письмо с `postmaster@` на `check-auth@verifier.port25.com` возвращает отчёт
SPF/DKIM (подпись Ed25519 старые проверяющие не понимают, поэтому писем подписей две — вторая RSA).

## Stalwart: учётки и доступ

- **Администратор** — учётка со случайным именем и ролью Admin, пароль из 48 символов,
  `allowedIps` только 127.0.0.1 и ::1: снаружи (IMAP, SMTP, JMAP через nginx) он не входит, nginx к
  тому же отвечает 403 на Basic-auth любого логина с правами сверх пользователя (`admin`, `recovery-*`,
  администратор, служебная учётка; список пишет `configure.py` в `/etc/nginx/tabora-privileged-logins.map`).
  Проброс `ssh -L 8080:127.0.0.1:8080 tabora` разрешён (sshd: `AllowTcpForwarding local`,
  `PermitOpen 127.0.0.1:8080`; к другим портам проброс запрещён), и через него с ноутбука работает
  API администратора: `curl -u '<логин>:<пароль>' http://127.0.0.1:8080/jmap/…` (логин и пароль из
  `stalwart-admin.env`). **Веб-панель `/admin` через туннель не входит:** страница открывается, но вход
  в ней — OAuth, а Stalwart выдаёт клиента OAuth (`/admin/oauth-client.json`) только для публичного
  имени (`STALWART_PUBLIC_URL` = `https://mx.tabora.app`; на `127.0.0.1:8080` — 404) и отправляет на
  `https://mx.tabora.app/login`, который nginx наружу не публикует намеренно. Менять публичный URL ради
  панели нельзя (на нём автонастройка и OAuth пользователей). Всё администрирование — скриптами
  `infra/stalwart/*.py`; если панель понадобится, решать отдельно (отдельное имя за туннелем Cloudflare
  с Access либо временный `STALWART_RECOVERY_MODE` при закрытом файрволе).
- **tabora-server** — учётка с ролью User плюс `sysAccount{Get,Query,Create,Update,Destroy}`,
  `sysDomain{Get,Query}`: создание и удаление пользователей и их алиасов. Вход только ключом API
  (пароля у учётки нет), ключ работает только с 127.0.0.1/::1. Stalwart не даёт ей выдать права, которых у
  неё нет, и трогать учётки с большими правами (администратора). Проверено на сервере на временных
  учётках: ключ не может создать учётку с ролью Admin, повысить пользователя или себя, изменить,
  переименовать, удалить администратора, сменить ему пароль или снять `allowedIps` (ответ
  `forbidden: You are not authorized to grant permissions…`); секреты при чтении учёток скрыты.
  Обычному пользователю ключ может сменить пароль и выдать права из своего набора — это его работа.
  Нельзя давать служебной учётке `sysRole*` и `sysAuthenticationUpdate`: через роли по умолчанию это
  путь к правам администратора. Сверх того мониторинг каждые 5 минут сверяет привилегированные учётки
  со снимком последнего `deploy.sh setup` (`/var/lib/tabora/privileged.json`) и обновляет карту nginx.
  Ограничить домен в OSS-версии нельзя
  (тенанты — Enterprise), но домен один. Новый ключ: удалить `STALWART_API_KEY` из `server.env` и
  `deploy.sh setup` (старый ключ при этом отзывается).
- **Аварийный администратор** (`STALWART_RECOVERY_ADMIN`) обходит `allowedIps`, поэтому в
  `stalwart.env` его нет. Он появляется только на время создания постоянного администратора
  (`setup.sh` делает это сам, если `stalwart-admin.env` нет или пароль не подходит) и сразу убирается.

- **postmaster@** — обычный ящик (роль User) с алиасами `abuse`, `hostmaster`, `security`, `webmaster`,
  `hello` (адрес для связи на сайте);
  пароль в `postmaster.env`, читать по IMAP/JMAP после включения TLS.
- **Шифрование почты на диске** (`encryptionAtRest`) у новых учёток `Disabled` (проверено), общий
  выключатель `x:Encryption.atRestEnable` включён, но настройки «включать всем» в Stalwart нет: нужен
  открытый ключ пользователя. **Требование к tabora-server:** при регистрации загружать открытый ключ
  пользователя (`x:PublicKey`) и ставить учётке `encryptionAtRest: {"@type":"Enabled","publicKey":<id>,
  "encryptOnAppend":true}`. До этого почта на диске и в копиях Stalwart открыта (репозиторий restic зашифрован).

## Резервные копии

`tabora-backup.timer` ежедневно около 03:15 запускает `infra/backup/backup.sh`: restic (шифрование
AES-256, пароль в `backup.env`) сохраняет

- данные Stalwart. У RocksDB в Stalwart 1.1 нет снимка «на ходу» (`--export` и любое чтение базы
  требуют остановленной службы), поэтому служба останавливается на 1–2 секунды: неизменяемые файлы
  берутся жёсткими ссылками, остальные копируются, считаются sha256. Всё состояние Stalwart — это
  `/opt/stalwart/data` и `/opt/stalwart/etc`;
- `pg_dump` базы `tabora` и роли (`pg_dumpall --globals-only`);
- `/etc/tabora`, `/opt/stalwart/etc`, `/etc/letsencrypt`, `/etc/cloudflared`, `/etc/nginx/sites-available`.

Хранение: 7 дневных, 4 недельных, 6 месячных. По воскресеньям `tabora-backup-check.timer` делает
`restic check` с чтением 10 % данных. О сбоях сообщает мониторинг.

**Сейчас копии только локальные** (`/var/backups/tabora-restic`, тот же диск): от ошибки или порчи базы
спасают, от потери сервера — нет; об этом напоминают журнал и motd. Подключить внешнее хранилище:

1. Сохранить `RESTIC_PASSWORD` из `/etc/tabora/backup.env` в менеджер паролей (без него копии не открыть;
   копия этого файла внутри репозитория бесполезна).
2. В `backup.env` задать `RESTIC_REPOSITORY`:
   - Hetzner Storage Box: `sftp://uXXXXXX@uXXXXXX.your-storagebox.de:23//home/tabora`; в Storage Box включить
     SSH и добавить ключ `/etc/tabora/backup_ed25519.pub`;
   - S3 (Hetzner Object Storage, B2 и др.): `s3:https://<endpoint>/<bucket>/tabora` плюс
     `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
3. `ssh tabora systemctl start tabora-backup` и `ssh tabora /usr/local/lib/tabora/backup/restore.sh verify`.
   Старый локальный каталог после этого можно удалить.

Проверка копии без изменения сервера: `restore.sh verify [копия]` — распаковка, сверка sha256, пробный
запуск Stalwart на копии в изолированной сети, `pg_restore` во временную базу. `restore.sh list`,
`restore.sh extract <каталог>`.

### Восстановление на новый сервер

1. Новый сервер Hetzner (Ubuntu 26.04) с ключом владельца; в `~/.ssh/config` поправить адрес `tabora`.
2. `infra/deploy.sh setup` — ставит всё, включая restic (создаст новые секреты, они будут заменены).
3. На сервере в `/etc/tabora/backup.env` вписать прежние `RESTIC_REPOSITORY` и `RESTIC_PASSWORD` (и ключи S3;
   для Storage Box — добавить в него новый `/etc/tabora/backup_ed25519.pub`).
4. `ssh tabora /usr/local/lib/tabora/backup/restore.sh list`, затем
   `ssh tabora /usr/local/lib/tabora/backup/restore.sh apply latest --yes` — секреты и настройки, данные
   Stalwart, база. Прежнее не удаляется, а переименовывается в `*.before-restore-<время>`.
5. `infra/deploy.sh setup` ещё раз (права, nginx, служба туннеля из `/etc/cloudflared`, хук certbot).
6. `infra/deploy.sh dns` (A/AAAA `mx` на новый адрес), PTR в Hetzner Console; сайт и API идут через
   туннель и адреса не требуют. Проверить: `health.py show`, вход в почту.

`apply` на рабочем сервере не запускался (он заменяет данные); его шаги — те же функции, что проверяет `verify`.

### Снапшот Hetzner и Rescue

Сервер из снапшота на другой машине получает сеть сам: netplan не привязан к MAC — DHCP (IPv4) включён
на любом интерфейсе `e*`, вход по ключу владельца сохраняется в образе. Статический IPv6 новой машины
при загрузке дописывает `tabora-network.service` из метаданных Hetzner. После такого восстановления:
`infra/deploy.sh setup`, DNS и PTR на новый адрес. Изменение сети применяется с проверкой связи и
автооткатом через 3 минуты; прежние файлы — в `/var/backups/tabora/netplan`.

Если входа всё же нет (пароль root заблокирован, консоль не поможет): Hetzner Console › сервер › Rescue ›
Enable rescue (linux64, свой ключ) › Power cycle; `ssh root@<адрес>`; `mount /dev/sda1 /mnt`; поправить
`/mnt/etc/netplan/50-tabora.yaml` (минимум: `ethernets: {z-any: {match: {name: "e*"}, dhcp4: true}}`),
`/mnt/root/.ssh/authorized_keys`, при бане — `rm /mnt/var/lib/fail2ban/fail2ban.sqlite3`; посмотреть
`/mnt/var/log`; `umount /mnt`, отключить Rescue, перезагрузить.

## Мониторинг и оповещения

`tabora-health.timer` каждые 5 минут: службы и порты (stalwart, nginx, postgresql, fail2ban, ufw;
cloudflared и tabora-server, когда установлены), место и inode, срок сертификатов (< 20 дней — продление
не работает), свежесть копии (36 ч) и `restic check`, упавшие юниты, часы, сбой certbot и его хука,
изменение привилегированных учёток Stalwart, события `security.ip-unauthorized` (верный пароль
администратора или ключ API предъявлен не с 127.0.0.1 — признак утечки; после смены секрета `health.py ack`).

Смотреть: при входе по SSH (motd), `ssh tabora /usr/local/lib/tabora/monitor/health.py show -a`,
`journalctl -u tabora-health`. Наружу — если в `/etc/tabora/alert.env` задан `ALERT_URL`:

- ntfy: поставить приложение ntfy, подписаться на тему с длинным случайным именем, вписать
  `ALERT_URL=https://ntfy.sh/<имя>` (`ALERT_FORMAT=ntfy`). Имя темы — секрет: кто знает, тот читает.
- вебхук Slack/Discord/Mattermost: `ALERT_URL=<адрес>`, `ALERT_FORMAT=json`; `ALERT_TOKEN` — если нужен Bearer.
- проверка: `ssh tabora /usr/local/lib/tabora/monitor/health.py test`.

Оповещение уходит при появлении и исчезновении проблемы и раз в сутки, пока она остаётся; в тексте только
имя сервера и результаты проверок. Если сервер недоступен целиком, изнутри он об этом не сообщит —
для этого нужен внешний пинг (например, проверка `https://tabora.app` любым uptime-сервисом).

## Журналы, баны, обновления

- Stalwart пишет события в journald (`journalctl -u stalwart`), неудачные входы — `auth.failed`.
- fail2ban (`fail2ban-client status`): `sshd` (10 ошибок — 10 минут; вход только по ключу), `stalwart`
  (SMTP AUTH и IMAP по журналу Stalwart; адрес берётся только вне кавычек, подставить чужой через имя
  учётки нельзя), `tabora-jmap` (401/403 на `/jmap` только для запросов с заголовком Authorization —
  журнал `/var/log/nginx/mx.access.log`, формат `tabora_mx` с признаком `auth=0|1` без самого заголовка
  и имени), `nginx-botsearch`, `recidive` (неделя, но только порты почты и 443). Порт 22 закрывает только
  `sshd` и ненадолго; HTTP-ошибки считает одна тюрьма, почтовые — другая, так что серия ошибок даёт
  один бан. В `ignoreip` только loopback. Снять бан: Hetzner Console (или Rescue) либо другой адрес,
  `fail2ban-client unban <адрес>`.
- Встроенный автобан Stalwart: 100 неудачных входов за сутки с адреса — блокировка (`x:BlockedIp`) на
  сутки (`authBanPeriod`; также сутки за перебор получателей и «зависшие» соединения, 7 суток за
  сканирование — по умолчанию было навсегда); 127.0.0.1 и ::1 не блокируются никогда.
- Ubuntu и `cloudflared` обновляются через unattended-upgrades, службы перезапускает needrestart,
  перезагрузка при необходимости в 04:30.
- Stalwart не обновляется сам: версия и sha256 архива закреплены в `setup.sh`. Раз в неделю
  `tabora-stalwart-release.timer` проверяет новый релиз и пишет напоминание в журнал и при входе по SSH.
  Обновление: сверить хеш архива с `.sigstore.json` релиза (`sigstore verify github --cert-identity
  https://github.com/stalwartlabs/stalwart/.github/workflows/ci.yml@refs/tags/<версия> …`), поменять
  `STALWART_VERSION` и `STALWART_SHA256`, `deploy.sh setup`.
- cloud-init после первичной настройки отключён (`/etc/cloud/cloud-init.disabled`): при перезагрузке
  он гонится с переименованием сетевого интерфейса и падает; сеть — в `/etc/netplan/50-tabora.yaml`
  (см. «Снапшот Hetzner и Rescue»), интерфейсы называются `enp1s0` (публичный) и `enp7s0`.
  Увеличенный в Hetzner диск расширять вручную: `growpart /dev/sda 1 && resize2fs /dev/sda1`.
- Службы stalwart, tabora-server, cloudflared ограничены systemd (`systemd-analyze security <служба>`:
  около 1.5); `/proc` смонтирован с `hidepid=invisible` (logind и polkit — в группе `proc`).
