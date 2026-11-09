# DNS tabora.app

`tabora.app.zone` — записи, которые публикует Stalwart для домена (DKIM, SPF, DMARC, MX, SRV, MTA-STS, автонастройка).
Сгенерировано `stalwart/configure.py` на сервере (копия в `/etc/tabora/dns-tabora.app.zone`).

Дополнительно к ним нужны адресные записи на сервер 2.29.138.249 / 2a01:4f9:c015:6ffa::1:
`tabora.app`, `www`, `mx`, `api` (A и AAAA). Ротация DKIM в Stalwart заморожена, ключи не меняются без нашего участия.
