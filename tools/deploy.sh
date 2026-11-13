#!/usr/bin/env bash
# Deployment from a laptop of what this repository builds for the Tabora host:
#   tools/deploy.sh web         the web app (app.tabora.app)
#   tools/deploy.sh support     the support site (support.tabora.app)
#   tools/deploy.sh downloads   signed installers from .build/signed
# The host itself (nginx, TLS, DNS, the account server) is set up from the server repository
# (Tabora-App/server, infra/); the website is deployed from Tabora-App/site.
set -euo pipefail
HOST=${HOST:-tabora}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
what=${1:-}
case "$what" in
  web)
    # Built on this machine (tools/web/build.mjs, package versions are pinned) and published to
    # /var/www/app.<domain>: first into a neighbouring directory, then into place with one command,
    # so a visitor never gets a page that links to files that have not arrived yet. The host name
    # must be enabled in nginx and DNS (server repository: infra/deploy.sh tls, dns).
    # The translation dictionaries are checked by tools/i18n (its own pinned code parser); the
    # build fails if the code has a string without a translation.
    (cd "$ROOT/tools/i18n" && npm ci --ignore-scripts --no-audit --no-fund --silent && node extract.mjs web --strict)
    (cd "$ROOT/tools/web" && npm ci --ignore-scripts --no-audit --no-fund --silent && node build.mjs "$ROOT/.build/web")
    [ -f "$ROOT/.build/web/index.html" ] && [ -f "$ROOT/.build/web/build.json" ] || { echo "the web app build failed"; exit 1; }
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}; install -d -m 755 -o root -g root "/var/www/app.$DOMAIN" "/var/www/app.$DOMAIN.next"'
    rsync -az --delete "$ROOT/.build/web/" "$HOST:/var/www/app.${DOMAIN:-tabora.app}.next/"
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}
      rsync -a --delete --chown=root:root --chmod=D755,F644 "/var/www/app.$DOMAIN.next/" "/var/www/app.$DOMAIN/"
      rm -rf "/var/www/app.$DOMAIN.next"
      echo "web app updated: $(python3 -c "import json; d = json.load(open(\"/var/www/app.$DOMAIN/build.json\")); print(\"version\", d[\"version\"], \"files\", len(d[\"files\"]))")"'
    ;;
  support)
    # The support site: built on this machine (tools/web/build-support.mjs) and published to
    # /var/www/support.<domain> the same way as the web app. The host name must be enabled in nginx
    # and DNS first (server repository: infra/deploy.sh tls, nginx, dns), and the account server
    # must know the sign-in of the support site and requests without an account (infra/deploy.sh server).
    (cd "$ROOT/tools/i18n" && npm ci --ignore-scripts --no-audit --no-fund --silent && node extract.mjs web --strict)
    (cd "$ROOT/tools/web" && npm ci --ignore-scripts --no-audit --no-fund --silent && node build-support.mjs "$ROOT/.build/support")
    [ -f "$ROOT/.build/support/index.html" ] && [ -f "$ROOT/.build/support/build.json" ] || { echo "the support site build failed"; exit 1; }
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}; install -d -m 755 -o root -g root "/var/www/support.$DOMAIN" "/var/www/support.$DOMAIN.next"'
    rsync -az --delete "$ROOT/.build/support/" "$HOST:/var/www/support.${DOMAIN:-tabora.app}.next/"
    ssh "$HOST" 'set -euo pipefail; DOMAIN=${DOMAIN:-tabora.app}
      rsync -a --delete --chown=root:root --chmod=D755,F644 "/var/www/support.$DOMAIN.next/" "/var/www/support.$DOMAIN/"
      rm -rf "/var/www/support.$DOMAIN.next"
      echo "support site updated: $(python3 -c "import json; d = json.load(open(\"/var/www/support.$DOMAIN/build.json\")); print(\"version\", d[\"version\"], \"files\", len(d[\"files\"]))")"'
    ;;
  downloads)
    # Installers from .build/signed -> /var/www/downloads (nginx serves them as /downloads/). Older
    # versions on the host are kept. Prints sha256 from the host at the end: compare it with the
    # checksum shown on the website.
    shopt -s nullglob
    files=("$ROOT"/.build/signed/*.dmg)
    shopt -u nullglob
    [ ${#files[@]} -gt 0 ] || { echo "no files in .build/signed/*.dmg"; exit 1; }
    echo "local:"; shasum -a 256 "${files[@]}"
    ssh "$HOST" 'install -d -m 755 -o root -g root /var/www/downloads'
    rsync -az --progress "${files[@]}" "$HOST:/var/www/downloads/"
    ssh "$HOST" 'cd /var/www/downloads && chown root:root -- *.dmg && chmod 644 -- *.dmg && echo "on the host:" && sha256sum -- *.dmg'
    ;;
  *) echo "usage: tools/deploy.sh web | support | downloads"; exit 1 ;;
esac
