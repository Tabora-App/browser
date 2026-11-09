#!/bin/sh
# certbot deploy-hook (ставит infra/lib.sh: install_certbot_hook). Скрипты лежат в
# /usr/local/lib/tabora, а не в каталоге развёртывания, поэтому хук не зависит от deploy.sh.
case "${RENEWED_LINEAGE:-}" in
  */__MAIL_HOST__) ;;
  *) exit 0 ;;
esac
systemctl reload nginx
python3 /usr/local/lib/tabora/stalwart/upload-cert.py "$RENEWED_LINEAGE"
