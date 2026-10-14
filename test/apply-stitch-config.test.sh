#!/bin/sh
# Exercises deploy/apply-stitch-config.sh in a sandbox: real files, a fake
# `docker`, paths rewritten under a temp root. No root, no Stitch needed.
#   sh test/apply-stitch-config.test.sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
R=$(mktemp -d); trap 'rm -rf "$R"' EXIT
mkdir -p "$R/etc/cambio" "$R/opt/cambio/stitch" "$R/srv/bots/b1" "$R/var/lib/cambio-stitch" "$R/bin"
printf 'BOT_ID=b1\nFEED_BASE=http://172.17.0.1:8787\nBOTS_DIR=%s/srv/bots\n' "$R" > "$R/etc/cambio/stitch-bot"
cp "$here/test/fixtures/panel-stitch.toml" "$R/srv/bots/b1/stitch.toml"
# Fakes: docker reports a running container; chown is a no-op; sha256sum on macOS.
printf '#!/bin/sh\n[ "$1" = inspect ] && echo "${FAKE_STATE:-true false}"; echo "docker $*" >> %s/docker.log\n' "$R" > "$R/bin/docker"
printf '#!/bin/sh\nexit 0\n' > "$R/bin/chown"
command -v sha256sum >/dev/null || printf '#!/bin/sh\nshasum -a 256 "$@"\n' > "$R/bin/sha256sum"
printf '#!/bin/sh\nexit 0\n' > "$R/bin/sleep"
chmod +x "$R/bin/"*
sed -e "s#/etc/cambio#$R/etc/cambio#; s#/opt/cambio#$R/opt/cambio#; s#/var/lib/cambio-stitch#$R/var/lib/cambio-stitch#" \
  "$here/deploy/apply-stitch-config.sh" > "$R/apply.sh"
run() { PATH="$R/bin:$PATH" sh "$R/apply.sh" "$@"; }
patch() { (cd "$here" && deno eval "
  import { patchStitch } from './src/stitchconf.ts';
  const t = await Deno.readTextFile('$R/opt/cambio/stitch/live.toml');
  await Deno.writeTextFile('$R/opt/cambio/stitch/stitch.toml', patchStitch(t, { 'wars-usdt': '$1' }, 'http://172.17.0.1:8787').text);"); }
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; exit 1; }
live="$R/srv/bots/b1/stitch.toml"

run pull >/dev/null && cmp -s "$live" "$R/opt/cambio/stitch/live.toml" && ok "pull copies the live file" || no "pull"
patch elevated
run install >/dev/null && grep -q 'buy_offset_bps = 45' "$live" && grep -q 'restart stitch-b1' "$R/docker.log" \
  && ok "install writes the patch and restarts stitch-b1" || no "install"

run install >/dev/null 2>&1 && no "second install without a pull" || ok "install refuses without a fresh pull"

run pull >/dev/null; patch calm
echo 'rpc_url = "https://evil.example"' >> "$R/opt/cambio/stitch/stitch.toml"
run install 2>&1 >/dev/null | grep -q "lines Cambio does not own" && ok "a changed line Cambio does not own is refused" || no "foreign line"

run pull >/dev/null; patch calm
sed -i.bak 's#http://172.17.0.1:8787/feed/wars-usdt#https://evil.example/feed/wars-usdt#' "$R/opt/cambio/stitch/stitch.toml"
run install 2>&1 >/dev/null | grep -q "feed_url points somewhere" && ok "a feed_url off FEED_BASE is refused" || no "foreign feed"

run pull >/dev/null; patch calm
echo "# edited in the panel" >> "$live"
run install 2>&1 >/dev/null | grep -q "changed since the pull" && ok "a panel save between pull and install is kept" || no "panel edit"

run pull >/dev/null; patch calm
before=$(cat "$live")
FAKE_STATE="false true" PATH="$R/bin:$PATH" sh "$R/apply.sh" install >/dev/null 2>&1 && no "crash not detected" || true
[ "$(cat "$live")" = "$before" ] && ok "a bot that will not stay up is rolled back" || no "rollback"

run pull >/dev/null
rm "$R/opt/cambio/stitch/stitch.toml"; ln -s "$R/etc/cambio/stitch-bot" "$R/opt/cambio/stitch/stitch.toml"
run install >/dev/null 2>&1 && no "symlink followed" || ok "a symlinked candidate is refused"
rm "$R/opt/cambio/stitch/live.toml"; ln -s "$R/etc/cambio/stitch-bot" "$R/opt/cambio/stitch/live.toml"
run pull >/dev/null && [ ! -L "$R/opt/cambio/stitch/live.toml" ] && grep -q '^BOT_ID=b1$' "$R/etc/cambio/stitch-bot" \
  && ok "pull replaces a planted symlink instead of writing through it" || no "pull symlink"
echo "all passed"
