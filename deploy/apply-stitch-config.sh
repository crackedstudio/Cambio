#!/bin/sh
# Cambio's two touches on the Stitch bot the panel runs. As root, via sudo:
#
#   apply-stitch-config.sh pull     copy the bot's live stitch.toml to
#                                   /opt/cambio/stitch/live.toml for patching
#   apply-stitch-config.sh install  put /opt/cambio/stitch/stitch.toml back
#                                   and restart the bot
#
# The news agent runs them as STITCH_PULL_CMD / STITCH_RESTART_CMD. Root-owned,
# allowed by deploy/sudoers-cambio with these two arguments only.
#
# The panel (textile-stitch @ 109ed6e) keeps each bot at
# $BOTS_DIR/<id>/stitch.toml and runs it as container stitch-<id>.
#
# What "cambio" can do through this, even if that account is compromised:
# change Cambio's own five pool keys (src/stitchconf.ts OWNED_POOL_KEYS), with
# every feed_url pointing at FEED_BASE. Nothing else. `install` compares the
# candidate with the live file minus those lines and refuses any other
# difference — a new key, a different maker, a different RPC, another pool.
set -eu
umask 077

CONF=/etc/cambio/stitch-bot           # root-owned: BOT_ID=, FEED_BASE=, optional BOTS_DIR=
[ -r "$CONF" ] || { echo "no $CONF" >&2; exit 1; }
BOT_ID=$(sed -n 's/^BOT_ID=\([A-Za-z0-9_-]*\)$/\1/p' "$CONF")
FEED_BASE=$(sed -n 's/^FEED_BASE=\(https\{0,1\}:\/\/[A-Za-z0-9.:_-]*\)$/\1/p' "$CONF")
BOTS_DIR=$(sed -n 's/^BOTS_DIR=\(\/[A-Za-z0-9_./-]*\)$/\1/p' "$CONF")
BOTS_DIR=${BOTS_DIR:-/srv/stitch/bots}
[ -n "$BOT_ID" ] || { echo "BOT_ID missing or malformed in $CONF" >&2; exit 1; }
[ -n "$FEED_BASE" ] || { echo "FEED_BASE missing or malformed in $CONF" >&2; exit 1; }

LIVE="$BOTS_DIR/$BOT_ID/stitch.toml"
DIR=/opt/cambio/stitch                 # cambio-owned: never follow links in it
STAMP=/var/lib/cambio-stitch/pulled.sha256   # root-only dir (install.sh): hash of what was pulled
CONTAINER="stitch-$BOT_ID"
OWNED='^[[:space:]]*(feed_url|buy_offset_bps|sell_offset_bps|buy_total_liquidity_debt|sell_total_liquidity_collateral)[[:space:]]*=|^# set by Cambio'

[ -f "$LIVE" ] && [ ! -L "$LIVE" ] || { echo "no regular file at $LIVE — is BOT_ID right?" >&2; exit 1; }

case "${1:-}" in
pull)
  # Write a fresh file and rename it into place: the rename replaces whatever
  # sits at live.toml (a symlink included) without following it.
  tmp=$(mktemp "$DIR/.live.XXXXXX")
  cat "$LIVE" > "$tmp"
  chmod 0644 "$tmp" && chown cambio:cambio "$tmp"
  mv -f "$tmp" "$DIR/live.toml"
  sha256sum "$LIVE" | cut -d' ' -f1 > "$STAMP"
  echo "pulled $LIVE"
  ;;
install)
  [ -f "$DIR/stitch.toml" ] && [ ! -L "$DIR/stitch.toml" ] || { echo "no regular file at $DIR/stitch.toml" >&2; exit 1; }
  # Every check below runs on root's own copy, so the file cannot change
  # between being checked and being installed.
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cat "$DIR/stitch.toml" > "$work/new"
  cp "$LIVE" "$work/live"

  # Someone saved in the panel since the pull: installing would undo it.
  [ -s "$STAMP" ] && [ "$(sha256sum "$work/live" | cut -d' ' -f1)" = "$(cat "$STAMP")" ] \
    || { echo "refusing: $LIVE changed since the pull (edited in the panel?); next pass re-pulls" >&2; exit 3; }

  # Only Cambio's lines may differ.
  grep -Ev "$OWNED" "$work/live" > "$work/live.rest" || true
  grep -Ev "$OWNED" "$work/new" > "$work/new.rest" || true
  cmp -s "$work/live.rest" "$work/new.rest" \
    || { echo "refusing: the candidate changes lines Cambio does not own" >&2; diff "$work/live.rest" "$work/new.rest" | head -20 >&2; exit 2; }
  # And every feed it adds or changes is ours. Lines already live — another
  # pool's own feed, say — are the panel's business, not ours to judge.
  grep -E '^[[:space:]]*feed_url[[:space:]]*=' "$work/live" > "$work/feeds.live" || true
  grep -E '^[[:space:]]*feed_url[[:space:]]*=' "$work/new" | grep -vxF -f "$work/feeds.live" > "$work/feeds.changed" || true
  if grep -vqF "= \"$FEED_BASE/feed/" "$work/feeds.changed"; then
    echo "refusing: a feed_url points somewhere other than $FEED_BASE" >&2; exit 2
  fi
  grep -q '^\[rfq\]' "$work/new" || { echo "refusing: no [rfq] table — Connect the bot in the panel first" >&2; exit 2; }

  cp -p "$LIVE" "$LIVE.cambio-prev"
  # Write through the existing file: owner, mode and inode stay the panel's.
  cat "$work/new" > "$LIVE"
  rm -f "$STAMP"
  docker restart "$CONTAINER" >/dev/null

  # Stitch reads the file at startup; a file it rejects shows as a container
  # that will not stay up. Give it time, then put the old file back if so.
  sleep 20
  if [ "$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' "$CONTAINER")" != "true false" ]; then
    cat "$LIVE.cambio-prev" > "$LIVE"
    docker restart "$CONTAINER" >/dev/null
    echo "rolled back: $CONTAINER did not stay up on the new config" >&2
    exit 4
  fi
  echo "installed and restarted $CONTAINER"
  ;;
*)
  echo "usage: $0 pull|install" >&2; exit 64 ;;
esac
