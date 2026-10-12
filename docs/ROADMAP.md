# Cambio — status and roadmap

Where Cambio stands, what is left, and how we will know each piece is done.
Update this file as items move; it is the team's single source of truth.

**Deadline:** Mon **9 Nov 2026, 09:00 GMT** (Agents on Open Rails, Loops House).
**Tracks:** Open Corridors: **Textile FX** ($750 / $250) · **Build with buy** ($200 × 5).
**Last updated:** 12 Oct 2026.

Legend: ✅ done and verified · 🟡 built, not yet run live · ⬜ not started ·
👤 needs a team member (keys, money, accounts) · 🤖 can be built in code

---

## How we are judged

| Track | Criterion | Weight | What moves it |
|---|---|---|---|
| Textile FX | Strategy P&L | 40% | Spread earned minus losses to stale quotes, net of data cost |
| | Volume quoted and filled | 30% | Hours live × corridors × size; reliable uptime |
| | Originality | 30% | Paid news signals driving the risk regime; crypto-dollar anchor; inventory skew |
| Build with buy | Use case and problem solved | 40% | A real loss mechanism (being picked off on news) for a named user (the maker operator) |
| | Depth of the integration | 35% | Paid calls that visibly change quoting, logged with receipts |
| | Demand created for the agents consumed | 25% | Steady, budgeted calls to the buy gateway from our tagged wallet |

Bounty wording to satisfy literally:
- Textile: *"a quoting strategy live on Textile FX on Celo mainnet … strongest P&L, meaningful volume quoted and filled, and an original approach to pricing, risk, or treasury management."*
- buy: *"products that solve a real problem for a named user by paying for services and agents they don't own over x402 on Celo mainnet, with verified paid calls from the project's tagged wallet and new demand for the agents consumed."*

---

## Status at a glance

| Area | Status |
|---|---|
| Fair-value engine | ✅ built, tested, run live (no money) |
| Price feed for Stitch (incl. off switch) | ✅ built, run live (no money) |
| News risk agent (buy, x402) | 🟡 built and dry-run on fixtures; **no paid call yet** |
| Stitch config generator | ✅ built, tested; keys not yet checked against an installed Stitch |
| P&L ledger + daily loss halt | ✅ built, verified on a real Celo fill (another maker's) |
| Accounts, wallets, capital | ⬜ 👤 |
| Stitch installed and enrolled on Celo | ⬜ 👤 |
| Live quoting | ⬜ |
| Dashboard | ⬜ 🤖 |
| Hosting (VPS, process supervision) | ⬜ 👤🤖 |
| ERC-8004 identity, attribution | ⬜ 👤🤖 |
| Demo video, submission | ⬜ 👤 |

---

## ✅ Done and verified (12 Oct)

### Fair value — `src/fairvalue.ts`, `src/sources.ts`
- Sources: Uniswap USDT/wARS and USDT/wBRL pools on Celo · Textile ticker · dolarapi `cripto` and `contadoconliqui` (pesos) · AwesomeAPI USD/BRL and Banco Central PTAX (reais).
- Median of fresh sources, 150 bps outlier cut, **no price** below 2 sources or above 120 bps disagreement, ≤25 bps inventory skew.
- **Verified live:** wARS fair 1,606.02 from four sources within 0.2% (pool 1,604.21 · Textile 1,606.00 · cripto 1,607.40 · CCL 1,606.05). wBRL 5.025 from the two on-chain sources (12 Oct was a Brazilian holiday: off-chain sources correctly dropped as stale).

### Feed and off switch — `src/feed.ts`
- `GET /feed/wars-usdt`, `/feed/wbrl-usdt` → `{price, timestamp}` in **USDT per local token** (Stitch's required orientation, pinned by a test). `GET /status` explains every number.
- **Verified:** served 0.000622654 for wARS; returned **503 "regime shock"** for wARS while still serving wBRL under a simulated shock.

### News risk agent — `src/news.ts`
- x402 client on the official SDK, **USA₮ by default**, against `gateway.usebuy.ai` `x.posts.search` ($0.005, x402 v1, network `celo` — confirmed by reading its 402).
- Per-call cap, daily budget, adaptive polling (20 min calm / 5 min otherwise), every call logged to `state/spend.jsonl` with receipt, score, top posts and whether quoting changed.
- **Verified (unpaid fixture):** crisis posts → wARS `shock` (score 46), calm posts → wBRL `calm` (score 3); `stitch.toml` rewritten accordingly.

### Stitch config — `src/stitchconf.ts`
- Renders `stitch.toml` for Celo 42220 with the reactor and Permit2 addresses, one pool per corridor, spread × regime, size × regime, exact 18dp integers. Example committed: `stitch/stitch.celo.example.toml`.

### Ledger — `src/ledger.ts`
- Fills = UniswapX `Fill(orderHash, filler, swapper, nonce)` on reactor `0xa9AA…35b3` with `swapper` = our maker; edge vs the pool at that block; equity vs baseline; data cost; net P&L; daily −$15 halt.
- **Verified** on a real Celo maker's fill `0x059102b0…151c`: sold 321,016 wARS for 199.98 USDT, edge **−$0.18** (an arbitrageur resold into the pool for +$0.17).

### Tests
- `deno task check` → 14 passing: price orientation, outliers, refusals, skew direction and cap, regime thresholds, repost dedupe, cool-off, config amounts, post parsing.

### Facts established (each would have cost money)
1. wARS tracks the **crypto/CCL dollar (~1,605)**, not the official rate (~1,512) — 6% apart.
2. Stitch's feed price is **debt per collateral** (≈0.000623), not 1,602.
3. Stitch **reads its config only at startup** → shocks go through the feed, spread changes through rewrite + restart.

---

## ⬜ Remaining work, in order

### Phase 0 — accounts and safety (👤, before anything goes live) · target **14 Oct**

| # | Task | Owner | Done when |
|---|---|---|---|
| 0.1 | Submitter enrolls in Agents on Open Rails (`npx loopshouse add agents-on-open-rails`, then enroll). **Must not be on Remesso's Loops team.** | 👤 submitter | `loops auth status` shows them; they have their own attribution tag |
| 0.2 | Ask Textile (Telegram / office hours) whether the Celo **wARS** and **wBRL** corridors accept a new maker, how makers enrol, and how fills are credited to a project | 👤 | Written answer saved in `docs/textile-answers.md` |
| 0.3 | Create the **maker wallet** (new key, never used by Remesso) | 👤 | Address in `.env` as `MAKER_ADDRESS`; key only in `stitch/stitch.env` |
| 0.4 | Create the **news-payer wallet** (separate key) | 👤 | `NEWS_PAYER_KEY` in `.env` |
| 0.5 | Fund the maker: ~$150 USDT + ~$150 of wARS (buy via the Uniswap pool or Ripio) + ~0.5 CELO. **Team's own money, not from Remesso wallets.** | 👤 | Balances visible on Celoscan |
| 0.6 | Fund the payer: ~$5 of USA₮ | 👤 | Balance visible |

### Phase 1 — Stitch in shadow (no money at risk) · target **18 Oct**

| # | Task | Owner | Done when |
|---|---|---|---|
| 1.1 | Rent a small VPS (always on); install Deno and Stitch | 👤 | `deno --version`, `stitch --version` on the box |
| 1.2 | Run `deno task feed` on the VPS behind a process supervisor (systemd) | 🤖 unit files + 👤 install | `/status` reachable from Stitch; restarts on crash |
| 1.3 | **Check Stitch's TOML keys** against the installed version's `stitch.example.toml`; fix `src/stitchconf.ts` if any differ | 🤖 | Stitch starts with our generated config and logs no unknown keys |
| 1.4 | Set `STITCH_RESTART_CMD` (e.g. `systemctl restart stitch`) | 👤 | A forced regime change restarts Stitch |
| 1.5 | Run Stitch in **lean shadow** on wARS; compare its intended quotes with `/status` for 24h | 👤 + 🤖 | Quotes sit at fair ± offset; no inverted prices |
| 1.6 | First **real paid buy call** (`deno task news --once`) | 👤 | A line in `state/spend.jsonl` with a receipt tx hash on Celoscan |

### Phase 2 — live, small · target **22 Oct**

| # | Task | Owner | Done when |
|---|---|---|---|
| 2.1 | `stitch approve` (Permit2) for USDT and wARS | 👤 | Approval txs confirmed |
| 2.2 | Go live on **wARS only**, wide spread (30 bps), caps as in `src/config.ts` | 👤 | First fill appears in `state/pnl.json` |
| 2.3 | Run `deno task ledger --watch` and `deno task news` under systemd | 🤖 + 👤 | Both survive a reboot |
| 2.4 | Daily check: edge per fill, adverse fills, data cost vs spread earned | 👤 | Notes in `docs/journal.md` |
| 2.5 | Alerting: message the team when the feed 503s, the regime changes, or the loss halt trips | 🤖 | A test alert received |

### Phase 3 — tune and widen · target **31 Oct**

| # | Task | Owner | Done when |
|---|---|---|---|
| 3.1 | Tighten the spread step by step (30 → 20 → 15 bps) while edge stays positive | 👤 | Journal shows each step and its effect |
| 3.2 | Add **wBRL** live (approvals, then quoting) | 👤 | wBRL fills in the ledger |
| 3.3 | Tune news weights and thresholds from `spend.jsonl` vs the fills that followed | 🤖 | Changes justified by logged data, committed with the evidence |
| 3.4 | Add **Reddit search** (`reddit.posts.search`, $0.005) as a second paid source if X alone misses events | 🤖 | Second capability in the spend log |
| 3.5 | Optional: a short model classifier for the ambiguous middle scores, keyword scorer kept as the floor | 🤖 | Only if 3.3 shows keyword misses |

### Phase 4 — evidence and submission · target **7 Nov** (2 days' margin)

| # | Task | Owner | Done when |
|---|---|---|---|
| 4.1 | **Dashboard**: public page from `state/pnl.json` + `spend.jsonl` — volume quoted and filled, edge, equity curve, data cost, regime timeline with the posts that caused each change | 🤖 | Live URL |
| 4.2 | Register an **ERC-8004 identity** for the maker wallet | 🤖 script + 👤 key | Agent id on 8004scan |
| 4.3 | Attribution: tag every transaction Cambio sends itself with the team's Loops code; document what cannot be tagged (x402 settlements, Stitch's own txs) | 🤖 | Tag decodes on a sent tx |
| 4.4 | Demo video (~2 min): the problem (the −$0.18 fill), the feed, a regime change from real posts, the ledger | 👤 | YouTube/Loom link |
| 4.5 | Screenshots of the dashboard and `/status` | 👤 | Files in `docs/screenshots/` |
| 4.6 | Submission: `loops project create` with description, repo, demo, screenshots, maker wallet, both bounty ids — **shown to the team before `--confirm`** | 👤 | Project visible on Loops |
| 4.7 | Run `loops evaluate` for both sponsors and close the gaps it names | 🤖 | Report addressed |

Bounty ids for 4.6: Textile FX 1st `f47e6f01-94c0-467b-afb9-8c004f0bae13`, 2nd `1a1b28af-acb1-4754-9770-0e9494b38555` · Build with buy `e9a90153-6486-4deb-8027-a931e5eea4d2`.

---

## Budget

| Item | Amount | Notes |
|---|---|---|
| Maker inventory | ~$300 | At risk; daily loss halt at $15 |
| Gas | ~0.5 CELO (~$0.05) | Approvals; takers pay fill gas |
| News data (buy) | ≤ $1.50/day | Capped in `.env`; ~$40 to the deadline at the cap |
| VPS | ~$5–10/month | Any always-on box |

---

## Risks and open questions

| Risk / question | Mitigation | Status |
|---|---|---|
| Corridor closed to new makers | Ask Textile first (0.2); fall back to wBRL or cNGN | ⬜ |
| Thin volume (~$1.9k/day wARS, ~$4.4k/day wBRL) | Two corridors, long uptime, competitive spread | known |
| Professional makers already quoting (one holds ~$113k) | Compete on reliability and risk discipline, not size | known |
| Picked off on news | The whole point: regimes + feed off switch | built |
| Stitch config key mismatch | Check against installed version (1.3) | ⬜ |
| buy response shape changes | `postTexts` walks any shape; failures never relax the regime | built |
| Data cost exceeds spread earned | Adaptive polling, daily cap, P&L reported net | built |
| Key compromise | Three separate wallets; maker key only in Stitch's env | design |
| Team-membership rule | Nobody on both the Remesso and Cambio Loops teams | ⬜ 👤 |

## Commands

```bash
deno task check                                          # typecheck + 14 tests
deno task feed                                           # price feed on :8787
curl localhost:8787/status                               # what the feed believes and why
deno task news --once --fixture test/fixtures/shock.json # dry run, pays nothing
deno task news                                           # live news agent (pays buy)
deno task ledger --watch                                 # P&L every 2 minutes
```
