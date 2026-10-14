# Runbook — from an empty server to quoting live

Phases 1 and 2 of [ROADMAP.md](../docs/ROADMAP.md), as commands. Every step
says how to check it worked. Nothing here moves money until **step 9**.

Facts this runbook relies on, checked against textile-stitch @ 109ed6e
(13 Oct 2026) and Textile's answers ([docs/textile-answers.md](../docs/textile-answers.md)):
- Stitch is run from its **panel** (Docker, reached over Tailscale on a
  server). Each bot is a folder `/srv/stitch/bots/<id>/` holding its
  `stitch.toml`, and a container `stitch-<id>`.
- **The maker key comes from the panel's wizard:** Add corridor → pick it →
  operator wallet key → approve allowances → **Connect** (Settings), which
  links the bot to Textile and asks you to verify an email address. Connect
  writes `[rfq]` into `stitch.toml`; the maker API key itself lives outside the
  file (`rfq-api.key` / `STITCH_RFQ_API_KEY`).
- A new bot quotes Swap **only over RFQ** — no `[rfq]`, no quotes.
- Stitch reads `stitch.toml` only at startup.
- A feed that answers with an error clears the bot's RFQ price at once — so
  Cambio's 503 in a news shock stops quoting immediately, not after a timeout.
- Feed `timestamp` must be whole Unix seconds, never ahead of the bot's clock.
  Cambio's feed stamps before reading its sources, so this holds while the
  host clock is synced (`timedatectl` shows `System clock synchronized: yes`).
- Celo's reactor is `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`.

**Who owns what in `stitch.toml`:** the panel owns the file. Cambio sets five
keys in each wARS/wBRL pool — `feed_url`, `buy_offset_bps`,
`sell_offset_bps`, `buy_total_liquidity_debt`,
`sell_total_liquidity_collateral` — and nothing else
(`src/stitchconf.ts` `patchStitch`). `deploy/apply-stitch-config.sh` enforces
that from root: it installs a change only if every other line is identical to
the live file and every new `feed_url` is Cambio's, and refuses if the file was
saved in the panel since Cambio read it.

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

```bash
STITCH_PULL_CMD="sudo /opt/cambio/deploy/apply-stitch-config.sh pull"
STITCH_RESTART_CMD="sudo /opt/cambio/deploy/apply-stitch-config.sh install"
```

`FEED_PUBLIC_URL` is set in step 6, once the bot's container exists.

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

## 5. Install Stitch and add the corridor (roadmap 0.2, 1.1)

Textile's server install (`docs/install-server.md` in
github.com/textile-protocol/textile-stitch): Docker + Compose v2, a Tailscale
account, then

```bash
curl -fsSL https://raw.githubusercontent.com/textile-protocol/textile-stitch/main/install-panel.sh | sh
```

Open the panel URL it prints (over Tailscale), then:

1. **Add corridor** → **wARS / USDT** on Celo. Paste the **maker wallet's**
   key (the one in `MAKER_ADDRESS`; never Remesso's, never the news payer's).
2. **Settings → Connect.** The wizard links the bot to Textile and asks you to
   **verify an email address** — that is how the maker key is issued. Use the
   team's address; the key is tied to it.
3. Leave the bot **stopped** for now. Don't approve allowances yet.

**Check:**
```bash
docker ps --format '{{.Names}}' | grep '^stitch-' | grep -v panel   # stitch-<id>: <id> is BOT_ID
sudo grep -A3 '^\[rfq\]' /srv/stitch/bots/<id>/stitch.toml          # shows maker_id
```

## 6. Let Cambio drive the bot

Tell the root-side script which bot, and where the feed is **as the container
sees it** (inside the container, `localhost` is the container itself):

```bash
GW=$(docker inspect stitch-<id> -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}')
sudo mkdir -p /etc/cambio
printf 'BOT_ID=<id>\nFEED_BASE=http://%s:8787\n' "$GW" | sudo tee /etc/cambio/stitch-bot
sudo chmod 0644 /etc/cambio/stitch-bot
echo "FEED_PUBLIC_URL=http://$GW:8787" | sudo tee -a /opt/cambio/.env
sudo systemctl restart cambio-feed
```

Then one pass with a fixture — pays nothing, patches the bot's config:

```bash
cx news --once --fixture test/fixtures/calm.json
```

**Check:** it prints `stitch.toml patched: wars-usdt` and `installed and
restarted stitch-<id>`. Any `refusing:` line says why. `wbrl-usdt` shows as
"not in the bot" until that corridor is added in the panel.

```bash
sudo grep -E 'feed_url|_offset_bps|total_liquidity' /srv/stitch/bots/<id>/stitch.toml
```

`feed_url` must be `http://<gateway>:8787/feed/wars-usdt`; the offsets and
caps match `src/config.ts`. Open the panel: the bot shows the same values.

If the panel warns that `lean_enabled` or `book_enabled` is on, turn it off
there: Cambio already skews the feed for inventory, and its caps assume RFQ only.

## 7. Shadow for 24 hours (roadmap 1.5)

Run the bot in dry-run for a day — from the panel, or:

```bash
docker exec stitch-<id> stitch --config /srv/stitch/bots/<id>/stitch.toml --dry-run 2>&1 | head -50
```

(the path inside the container may differ — `docker inspect stitch-<id>
-f '{{range .Mounts}}{{.Destination}} {{end}}'` shows where the folder is
mounted). Every few hours compare what it would quote with
`curl localhost:8787/status`: each side at fair value ± the offset, never
inverted, and the bot logs no unknown keys.

Then the first **real paid call** (roadmap 1.6):

```bash
cx news --once
tail -2 /opt/cambio/state/spend.jsonl
```

**Check:** the first line has `"capability":"x.posts.search"` and a
`receipt.transaction` that opens on celoscan.io.

## 8. Go live, small (roadmap 2.1–2.3)

**Money moves from here.** Maker funded per the roadmap (team's own funds).

In the panel: **approve allowances** (Permit2, on the bot's page), then
**Start**. Then Cambio's agents:

```bash
sudo systemctl enable --now cambio-ledger cambio-news
```

Start on wARS with a wide spread: set `baseOffsetBps: 30` for `wars-usdt` in
`src/config.ts` until the first week's journal says otherwise.

**Check:**
```bash
docker logs -f stitch-<id>                    # quotes going out
curl -s localhost:8787/api/dashboard | head   # fills appear after the first trade
sudo reboot                                   # then: systemctl is-active cambio-feed cambio-news cambio-ledger; docker ps
```

## 9. Optional: trade from a Textile vault (roadmap 3.6)

Textile vaults are **beta** — Textile's own word is that deploying one and
connecting it to Stitch "is still a bit rough". Only after a clean week on
the bot's own wallet.

1. Deploy one at https://app.textilecredit.com/s/vaults/deploy for the same
   pair (USDT settlement, wARS corridor), with the **maker wallet as strategy
   signer**. It will not appear on the public vaults list by default — keep
   its address.
2. **No yield adapter** while judging: Cambio's equity reads idle balances, so
   staked funds would make P&L read low.
3. Panel → Corridors → **Experimental → Trade from a vault**: it checks the
   vault, writes `[vault]`, turns the ladder and taker leg off, re-Connects
   with the vault as funding wallet and restarts the bot. No `approve` — the
   vault approves Permit2 itself.
4. `echo VAULT_WARS_USDT=0x… | sudo tee -a /opt/cambio/.env` and restart
   `cambio-feed` and `cambio-ledger`.

**Check:** `/status` shows the vault's balances under `inventory`, and the
next fill's swapper on celoscan is the vault. The ledger keeps counting the
bot wallet too, so fills from before the move stay in the P&L.

Cambio's `apply-stitch-config.sh` does not care which: `[vault]` is the
panel's line and passes through untouched.

## Daily (roadmap 2.4)

Open `/dashboard`, then add the day to [docs/journal.md](../docs/journal.md).

## Stop everything, fast

**Stop** in the panel, or:

```bash
docker stop stitch-<id>             # quotes stop; nothing new is signed
```

Or stop only the price: `sudo systemctl stop cambio-feed` — the bot's next
feed fetch fails and its RFQ price is cleared at once. Withdraw from the panel
(Funds tab).
