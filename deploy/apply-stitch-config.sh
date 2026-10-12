#!/bin/sh
# Install Cambio's regenerated stitch.toml where Stitch's service reads it,
# then restart Stitch (it reads its config only at startup).
#
# Run by the news agent as STITCH_RESTART_CMD="sudo /opt/cambio/deploy/apply-stitch-config.sh".
# Root-owned and allowed by one sudoers line (deploy/sudoers-cambio), so the
# "cambio" user can do exactly this and nothing else as root.
set -eu
SRC=/opt/cambio/stitch/stitch.toml
DST=/etc/stitch-bot/stitch.toml

[ -s "$SRC" ] || { echo "no $SRC" >&2; exit 1; }
# A file without [rfq] would start Stitch quoting nothing on Swap. Refuse it
# rather than silently take the bot off the venue.
grep -q '^\[rfq\]' "$SRC" || { echo "refusing: $SRC has no [rfq] table (run stitch connect first)" >&2; exit 2; }

cp "$DST" "$DST.prev" 2>/dev/null || true
install -m 0644 "$SRC" "$DST"
systemctl restart stitch
echo "stitch.toml installed and stitch restarted"
