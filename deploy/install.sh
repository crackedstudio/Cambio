#!/bin/sh
# One-time server setup for Cambio (Ubuntu/Debian, as root). Idempotent.
# Stitch itself is installed separately, with its panel (Textile's
# docs/install-server.md) — see deploy/RUNBOOK.md steps 5–6.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

id cambio >/dev/null 2>&1 || useradd --system --home /opt/cambio --shell /usr/sbin/nologin cambio
command -v deno >/dev/null || { curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh; }

# The repo lives at /opt/cambio (git clone https://github.com/crackedstudio/Cambio /opt/cambio).
[ -f /opt/cambio/deno.json ] || { echo "clone the repo to /opt/cambio first" >&2; exit 1; }
[ -f /opt/cambio/.env ] || { echo "create /opt/cambio/.env from .env.example first" >&2; exit 1; }
chown -R cambio:cambio /opt/cambio/state /opt/cambio/stitch
chmod 600 /opt/cambio/.env && chown cambio:cambio /opt/cambio/.env

# The config-swap script runs as root through sudo: it must be root-owned and
# not writable by "cambio", or the sudo rule would hand out root.
chown root:root /opt/cambio/deploy/apply-stitch-config.sh && chmod 0755 /opt/cambio/deploy/apply-stitch-config.sh
install -m 0440 /opt/cambio/deploy/sudoers-cambio /etc/sudoers.d/cambio && visudo -c
# Where that script records what it pulled — root's, so "cambio" cannot forge it.
install -d -m 0700 -o root -g root /var/lib/cambio-stitch

# Cache dependencies as the service user so first start is not a download.
mkdir -p /opt/cambio/.deno && chown cambio:cambio /opt/cambio/.deno
su -s /bin/sh cambio -c "cd /opt/cambio && DENO_DIR=/opt/cambio/.deno deno cache --frozen src/feed.ts src/news.ts src/ledger.ts"

for s in feed news ledger; do install -m 0644 /opt/cambio/deploy/cambio-$s.service /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now cambio-feed
echo "feed started: curl localhost:\${FEED_PORT:-8787}/status"
echo "start the others when ready:  systemctl enable --now cambio-ledger cambio-news"
