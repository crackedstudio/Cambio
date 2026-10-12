# Runbook — from an empty server to quoting live

Phases 1 and 2 of [ROADMAP.md](../docs/ROADMAP.md), as commands. Every step
says how to check it worked. Nothing here moves money until **step 9**.

Facts this runbook relies on, checked against textile-stitch @ 29f006e:
- Stitch's commands: `stitch --config <file>` runs it; `--dry-run` runs it
  without signing live quotes; `stitch approve --config <file>` sets Permit2
  approvals; `stitch connect --config <file>` enrols the maker with Textile and
  writes `[rfq]` + `rfq-api.key`.
- A new bot quotes Swap **only over RFQ** — no `[rfq]`, no quotes.
- Stitch reads `stitch.toml` only at startup.
- Celo's reactor is `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`.

One helper, used below — runs a Cambio task as the `cambio` user, from the
dependency cache `install.sh` filled (the user cannot write anywhere else):

```bash
cx() { sudo -u cambio env DENO_DIR=/opt/cambio/.deno sh -c "cd /opt/cambio && deno task $*"; }
```

---

## 1. Server (roadmap 1.1)

A small always-on Linux VPS (1 vCPU, 1 GB is enough), Ubuntu 22.04+.

```bash
sudo apt update && sudo apt install -y git curl unzip
sudo git clone https://github.com/crackedstudio/Cambio /opt/cambio
```

**Check:** `ls /opt/cambio/deno.json`.

## 2. Configure Cambio

```bash
sudo cp /opt/cambio/.env.example /opt/cambio/.env
sudo nano /opt/cambio/.env
```

Fill in: `MAKER_ADDRESS` (address only), `NEWS_PAYER_KEY` (the separate payer
wallet), `NEWS_DAILY_BUDGET`, `ATTRIBUTION_CODE` (**this project's** Loops
code), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, and
`STITCH_RESTART_CMD="sudo /opt/cambio/deploy/apply-stitch-config.sh"`.

## 3. Install Cambio's services (roadmap 1.2)

```bash
sudo /opt/cambio/deploy/install.sh
```

Creates the `cambio` user, installs Deno, caches dependencies, installs the
three systemd units and the one sudo rule, and starts the feed.

**Check:**
```bash
curl -s localhost:8787/status | head -c 600     # both corridors, "publish": true
curl -s localhost:8787/feed/wars-usdt           # {"price":0.00062…,"timestamp":…}
sudo systemctl kill cambio-feed && sleep 6 && systemctl is-active cambio-feed   # restarts on crash
```

`price` must be **below 1** (USDT per wARS). A number near 1,600 means the
orientation is inverted — stop and fix before anything else.

## 4. Alerts (roadmap 2.5)

```bash
cx alert-test
```

**Check:** the team's Telegram group receives "test alert".

## 5. Install Stitch

Follow Textile's guide for servers (`docs/install-server.md` in
github.com/textile-protocol/textile-stitch) and its `deploy/stitch.service`.
Put the maker key in `/etc/stitch-bot/stitch.key` (chmod 600) — **only there**.

**Check:** `stitch --version`.

## 6. Generate Stitch's config and enrol the maker

```bash
cd /opt/cambio
cx news --once --fixture test/fixtures/calm.json                           # writes stitch/stitch.toml, pays nothing
sudo cp stitch/stitch.toml /etc/stitch-bot/stitch.toml
sudo stitch connect --config /etc/stitch-bot/stitch.toml                   # enrols with Textile, writes [rfq]
sudo cp /etc/stitch-bot/stitch.toml stitch/stitch.toml && sudo chown cambio: stitch/stitch.toml
```

The last line brings `[rfq]` back into Cambio's copy, so every later
regeneration carries it (and `apply-stitch-config.sh` refuses a file without
it). Move `rfq-api.key` to `/etc/credstore/` as Stitch's service file says.

**Check:** `grep -A3 '^\[rfq\]' stitch/stitch.toml` shows `maker_id`.

## 7. Check the config keys (roadmap 1.3)

```bash
sudo stitch --config /etc/stitch-bot/stitch.toml --dry-run 2>&1 | head -50
```

**Check:** it starts, loads two pools, finds the feeds, logs no unknown or
ignored keys. Any key it rejects: fix `src/stitchconf.ts`, regenerate, repeat.

## 8. Shadow for 24 hours (roadmap 1.5)

Run Stitch in `--dry-run` for a day. Every few hours compare what it would
quote with `curl localhost:8787/status`: each side should sit at fair value ±
the offset, on the right side, never inverted.

Then the first **real paid call** (roadmap 1.6):

```bash
cx news --once
tail -2 /opt/cambio/state/spend.jsonl
```

**Check:** the first line has `"capability":"x.posts.search"` and a
`receipt.transaction` that opens on celoscan.io.

## 9. Go live, small (roadmap 2.1–2.3)

**Money moves from here.** Maker funded per the roadmap (team's own funds).

```bash
sudo stitch approve --config /etc/stitch-bot/stitch.toml --exact   # Permit2, only the configured caps
sudo systemctl enable --now stitch
sudo systemctl enable --now cambio-ledger cambio-news
```

Start on wARS with a wide spread: set `baseOffsetBps: 30` for `wars-usdt` in
`src/config.ts` (and remove the wBRL pool, or leave its caps at the minimum)
until the first week's journal says otherwise.

**Check:**
```bash
journalctl -u stitch -f                       # quotes going out
curl -s localhost:8787/api/dashboard | head   # fills appear after the first trade
sudo reboot                                   # then: systemctl is-active stitch cambio-feed cambio-news cambio-ledger
```

## Daily (roadmap 2.4)

Open `/dashboard`, then add the day to [docs/journal.md](../docs/journal.md).

## Stop everything, fast

```bash
sudo systemctl stop stitch          # quotes stop; nothing new is signed
```

Or stop only the price: `sudo systemctl stop cambio-feed` — Stitch then pulls
its quotes within `staleness_secs` (20 s). Withdraw with
`stitch withdraw --config … <token|native> <amount|all> <to>`.
