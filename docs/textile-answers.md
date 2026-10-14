# Textile's answers (roadmap 0.2)

Asked by the team, answered by Textile on 14 Oct 2026. Kept verbatim in
substance, with what each changes in Cambio.

## 1. How does a maker get a maker key?

> To get a maker key, you need to run Stitch and add a corridor in Stitch. In
> the last step the wizard will connect you to Textile and ask you to verify
> your email address. This is how a maker gets a maker key.

**What it changes:** enrolment is the panel's **Add corridor** wizard, ending
in **Connect** and an email verification — not a separate application to
Textile, and not the `stitch connect` CLI our first runbook used. Use the
team's email: the key is tied to it. Connect writes `[rfq]` into the bot's
`stitch.toml`; the API key itself stays outside the file (`rfq-api.key` /
`STITCH_RFQ_API_KEY`). RUNBOOK step 5.

Because the panel now writes the config, Cambio no longer generates it: it
patches five keys per pool and leaves the rest as the panel wrote it
(`src/stitchconf.ts` `patchStitch`, enforced by
`deploy/apply-stitch-config.sh`).

## 2. Can we deploy our own vault?

> Yes. You can use https://app.textilecredit.com/s/vaults/deploy. New vaults
> will not appear on https://app.textilecredit.com/s/vaults by default though.

**What it changes:** a team can hold its inventory in a Textile
OperatorVault instead of the bot's wallet. Not listed publicly by default, so
we keep its address ourselves (`VAULT_WARS_USDT` / `VAULT_WBRL_USDT`) and link
it from the dashboard and submission.

## 3. How does a vault connect to Stitch?

> In Stitch, in the corridor "Experimental" section you can connect your
> vault. But vaults are still in beta. So deploying them and connecting them
> with Stitch is still a bit rough.

**What it changes:** optional, and late — roadmap 3.6, only after a clean week
on the bot's own wallet. From Stitch's source (@ 109ed6e): with a vault, the
vault is the UniswapX swapper and recipient and holds the inventory; the bot's
key only signs. One vault serves one pair. The panel's "Trade from a vault"
checks the vault, writes `[vault]`, turns the ladder and taker leg off and
re-Connects with the vault as funding wallet. A vault approves Permit2 itself,
so there is no `approve` step.

Cambio follows the vault: the ledger counts fills where the swapper is the bot
wallet **or** a vault, equity sums both, and the inventory skew reads the
vault's balances. Run the vault **without a yield adapter** while judged —
Cambio's equity reads idle balances only.

## Still open

- Are the Celo **wARS** and **wBRL** corridors in the wizard's list for a new
  maker? (The wizard answers this the moment we open it.)
- How does Textile credit fills to a project for the hackathon — by maker id,
  by funding wallet, or by our Loops attribution tag? Stitch's own transactions
  cannot carry our tag.
