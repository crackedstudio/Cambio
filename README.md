# Cambio

**A news-aware market maker for LatAm stablecoins on Celo.** Cambio quotes
USDT↔wARS and USDT↔wBRL on [Textile FX](https://fx-docs.textilecredit.com),
and pays other agents over x402 to read the news — widening its spread or
stepping back before a peso shock, instead of being picked off by it.

Built for the Agents on Open Rails hackathon (Loops House × Celo):
**Open Corridors: Textile FX** and **Build with buy**.

**Where we are and what is left:** [docs/ROADMAP.md](docs/ROADMAP.md).

## The problem

Pesos and reais move on news — central-bank announcements, capital-control
rumours, a devaluation. A maker quoting these thin corridors loses money when
the news lands before its price does: traders fill the stale quote and resell
into a pool that has already moved. That is the main way a small maker loses,
and the reason few quote these corridors.

It is not hypothetical. The first Textile fill we inspected on Celo
(`0x059102b0…151c`) was a taker buying a maker's 321,016 wARS for 199.98 USDT
and selling them into the Uniswap pool for 200.15 USDT in the same
transaction: $0.17 straight out of the maker, measured by `src/ledger.ts` as
−$0.18 of edge against the pool.

**The user** is the maker operator — a small treasury quoting LatAm
stablecoins on Celo with its own capital.

## How it works

```
                 ┌──────────── buy gateway (x402, USA₮) ────────────┐
                 │  X search: devaluación, cepo, Copom…  $0.005/call │
                 └───────────────────────┬──────────────────────────┘
                                         │ posts
                                  src/news.ts ── regime: calm | elevated | shock
                                         │            │
                         rewrites stitch.toml     state/regime.json
                         (spread ×3, size ½)          │
                                         │            ▼
  Uniswap pool ┐                         │      src/feed.ts ──► /feed/wars-usdt
  Textile tick ├─► fair value ─► skew ───┴──►   {price, timestamp}   (503 = stop)
  dólar cripto │   (median, outliers out,                 │
  CCL / PTAX  ┘     refuse if they disagree)              ▼
                                               Stitch (Textile's maker bot)
                                                          │ fills on the reactor
                                                          ▼
                                                 src/ledger.ts → state/pnl.json
                                                 (edge vs pool per fill, equity,
                                                  data cost, daily loss halt)
```

### 1. Fair value — `src/fairvalue.ts`, `src/sources.ts`

- **Pesos are anchored on the crypto/CCL dollar, not the official rate.**
  Measured 2026-10-12: wARS on Celo at ~1,602–1,606 per dollar; dólar cripto
  1,605, contado con liqui 1,606; the official wholesale rate 1,512. Pricing
  off the official rate would be 6% wrong on every fill.
- Sources per corridor, fetched in parallel, each optional:
  - wARS: Uniswap USDT/wARS pool on Celo · Textile ticker · dolarapi `cripto` · dolarapi `contadoconliqui`
  - wBRL: Uniswap USDT/wBRL pool on Celo · Textile ticker · AwesomeAPI USD/BRL · Banco Central PTAX
- Median of fresh sources; any source more than 150 bps from it is dropped;
  **no price at all** if fewer than two remain or they span more than 120 bps.
- **Inventory skew**: up to 25 bps toward unloading whichever side we hold too
  much of.
- **Stitch reads the price as debt per collateral** — USDT per wARS
  (≈ 0.000623), not wARS per USDT. Inverting it "makes the bot post wildly
  mispriced orders" (Stitch's docs). One conversion, `toStitchPrice`, pinned by
  a test.

### 2. The off switch is the feed — `src/feed.ts`

The feed answers `503` instead of a price when the sources disagree, when the
regime is `shock`, or when the daily loss limit has been hit. Stitch's
`staleness_secs = 20` then pulls every quote on its own — no restart, and no
second process has to be alive for quoting to stop.

### 3. News risk agent — `src/news.ts` (the buy integration)

- Pays `x.posts.search` on the buy gateway (`gateway.usebuy.ai`) over x402 on
  Celo — **USA₮ by default**, USDT or USDC configurable — one search per
  corridor per poll, `within_time:1h`.
- Scores posts with a weighted term list (Spanish for Argentina, Portuguese
  for Brazil), each post counted once so reposts cannot fake a crisis →
  `calm` (score < 12), `elevated` (≥ 12), `shock` (≥ 30).
- **elevated**: spread ×3, size ½ (stitch.toml rewritten, Stitch restarted).
  **shock**: the feed withholds the price.
- Up is immediate; down only after an hour with no reading at that level.
- Polls every 20 minutes when calm, every 5 when not. Every call is checked
  against `NEWS_MAX_PER_CALL` before signing and against `NEWS_DAILY_BUDGET`
  before calling, and logged to `state/spend.jsonl` with its receipt (tx
  hash), the score, the top matching posts and whether it changed quoting.
- A failed read never relaxes the regime: no news is not good news.

### 4. Ledger — `src/ledger.ts`

- Finds our fills as UniswapX `Fill(orderHash, filler, swapper, nonce)` events
  on Textile's reactor `0xa9AA…35b3` with `swapper` = our maker.
- **Edge** per fill against the Uniswap pool's price *at that block*;
  **equity** at fair value against a baseline; **data cost** from the spend
  log. `totalPnlUsd` = equity change − data cost.
- Writes `state/halt.json` when the day's P&L passes −$15: the feed stops
  publishing until the next UTC midnight.

## Running it

Requirements: [Deno](https://deno.com) 2, [Stitch](https://github.com/textile-protocol/textile-stitch),
a VPS that can stay up.

```bash
cp .env.example .env            # fill MAKER_ADDRESS, NEWS_PAYER_KEY, budgets
deno task check                 # typecheck + tests

deno task feed                  # :8787 — /feed/wars-usdt, /feed/wbrl-usdt, /status
deno task news                  # pays buy, sets the regime, writes stitch/stitch.toml
deno task ledger --watch        # P&L every 2 minutes

# Stitch, pointed at the generated stitch/stitch.toml — install and run it
# per its README (Permit2 approvals first: `stitch approve`, needs a little CELO).
```

Dry runs that spend nothing:

```bash
deno task news --once --fixture test/fixtures/shock.json   # sample posts, no payment
curl localhost:8787/status                                  # what the feed believes and why
```

`stitch/stitch.celo.example.toml` is the generated config in calm conditions.

### Wallets — three, never shared

| Wallet | Holds | Key lives in |
|---|---|---|
| Maker (Stitch operator) | the inventory: USDT + wARS/wBRL, ~0.5 CELO for approvals | `stitch/stitch.env` only |
| News payer | a few dollars of USA₮ for x402 calls | `.env` (`NEWS_PAYER_KEY`) |
| — | Cambio never holds anyone else's money | — |

Start with roughly $300 (half USDT, half wARS) and the caps in
`src/config.ts` (75 USDT / 120,000 wARS per side), which are deliberately
below the balance — Textile's own advice is "start wide and small".

## Before going live — verify

- [ ] The Celo wARS and wBRL corridors accept a new maker (ask Textile).
- [ ] Stitch's TOML keys match `src/stitchconf.ts` for the version installed
      (a misspelt key is silently ignored).
- [ ] Run Stitch in **lean shadow** first and compare its quotes to `/status`.
- [ ] `STITCH_RESTART_CMD` restarts Stitch (e.g. `systemctl restart stitch`):
      Stitch reads its config only at startup.
- [ ] ERC-8004 identity registered for the maker wallet.
- [ ] Attribution: this project's own Loops tag (never Remesso's). Note what can
      and cannot carry it — x402 payments are submitted by the facilitator and
      Stitch sends its own approvals, so neither is tagged by Cambio; tag any
      transaction Cambio sends itself, and ask Textile how fills are credited.

## Honest limits

- The corridors are thin: Textile's 24h ticker showed ~$1,900 of USDT/wARS
  and ~$4,400 of USDT/wBRL. P&L will be dollars, not hundreds.
- Professional makers are already there (the fill above came from a wallet
  holding ~$113k).
- The keyword scorer is v1: readable and auditable, not clever. Tune the
  weights and thresholds from `state/spend.jsonl` against the fills that
  followed.
- Data is a cost against the spread: at ~$1.50/day it must earn its keep.
  The adaptive polling exists for that reason, and the ledger reports P&L net
  of it.
- Live on mainnet with real money. It can lose it.

## Layout

```
src/config.ts       corridors, addresses, risk limits
src/sources.ts      price sources
src/fairvalue.ts    blend, outlier rejection, skew, Stitch orientation  (pure)
src/regime.ts       posts → score → regime → effects                    (pure)
src/feed.ts         the HTTP feed Stitch polls; the off switch
src/news.ts         pays buy over x402, sets the regime, rewrites stitch.toml
src/stitchconf.ts   renders stitch.toml
src/ledger.ts       fills, edge, equity, data cost, daily loss halt
src/state.ts        shared JSON state under state/
test/               14 tests: orientation, outliers, skew, regimes, config
```
