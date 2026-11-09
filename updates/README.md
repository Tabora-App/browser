# Обновления Tabora

- `channel.json` — манифест канала: последняя версия, минимально допустимая (ниже неё обновление обязательное), заметки.
- `<канал>/<цель сборки>/update.xml` — манифест штатного обновлятора движка (полный MAR в GitHub Releases, sha512 и размер).

Файлы создаёт `tools/release.py` после упаковки сборки; пакеты подписываются ключом Tabora (`.build/mar-keys`,
публичные сертификаты в `src/toolkit/mozapps/update/updater/`). Клиент читает оба манифеста по raw-адресам GitHub
(prefs `tabora.update.channelUrl`, `tabora.update.url`).
