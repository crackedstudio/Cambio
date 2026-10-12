/// The news risk agent. It PAYS other agents for what it reads — X search
/// through the buy gateway, over x402 on Celo — turns the posts into a regime,
/// and moves Cambio's quoting with it.
///
///   deno task news                      # run forever
///   deno task news --once               # one poll, then exit
///   deno task news --once --fixture f   # read posts from a JSON file; pays nothing
///
/// Spending is bounded three ways: `NEWS_MAX_PER_CALL` (a quote above it is
/// refused before signing), `NEWS_DAILY_BUDGET` (summed from state/spend.jsonl,
/// checked before every call) and the wallet itself, which should hold only a
/// few dollars. Polling is adaptive — slower when calm, faster when not —
/// because the data is a cost against the strategy's P&L, and a maker that
/// pays $5/day to protect $2/day of spread has not solved anything.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { CORRIDORS, type CorridorId } from "./config.ts";
import { next, type Regime, regimeOf, type RegimeState, score } from "./regime.ts";
import { appendSpend, readRegimes, readSpend, writeJson } from "./state.ts";
import { renderStitch } from "./stitchconf.ts";

const GATEWAY = "https://gateway.usebuy.ai/v1/social/x/posts/search";
const ASSETS: Record<string, string> = {
  USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771",
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
};

/// One X search per corridor per poll. OR-ed terms and `within_time:1h` keep
/// it to the hour that matters; the scorer does the weighting.
const QUERIES: Record<CorridorId, string> = {
  "wars-usdt": "(devaluación OR \"corrida cambiaria\" OR cepo OR \"dólar blue\" OR BCRA OR \"feriado cambiario\") lang:es within_time:1h",
  "wbrl-usdt": "(\"dólar dispara\" OR \"intervenção cambial\" OR Copom OR \"real desvaloriza\" OR \"leilão de dólar\") lang:pt within_time:1h",
};

/// Minutes between polls, by the worst regime currently in force.
const INTERVAL_MINS: Record<Regime, number> = { calm: 20, elevated: 5, shock: 5 };

const args = Deno.args;
const once = args.includes("--once");
const fixture = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;

const maxPerCall = Number(Deno.env.get("NEWS_MAX_PER_CALL") ?? "0.01");
const dailyBudget = Number(Deno.env.get("NEWS_DAILY_BUDGET") ?? "1.50");
const asset = ASSETS[(Deno.env.get("NEWS_ASSET") ?? "USAT").toUpperCase()];
const feedBase = Deno.env.get("FEED_PUBLIC_URL") ?? `http://127.0.0.1:${Deno.env.get("FEED_PORT") ?? 8787}`;

/// Any string under a key that looks like post text. The gateway's response
/// shape belongs to its provider and can change; walking it beats binding to
/// one field name and silently reading nothing.
export function postTexts(body: unknown, out: string[] = []): string[] {
  if (Array.isArray(body)) body.forEach((b) => postTexts(b, out));
  else if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string" && /^(full_)?text$|^content$|^body$/i.test(k) && v.length > 10) out.push(v);
      else postTexts(v, out);
    }
  }
  return out;
}

/// What the gateway actually quoted for the last call, in dollars — logged as
/// the cost rather than a figure copied from its catalog.
let lastQuotedUsd = 0;

function payingFetch() {
  const key = (Deno.env.get("NEWS_PAYER_KEY") ?? "").trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("NEWS_PAYER_KEY is not set");
  const cap = BigInt(Math.round(maxPerCall * 1e6)); // all three tokens are 6dp
  // deno-lint-ignore no-explicit-any
  const select = (_v: number, accepts: any[]) => {
    const pick = accepts.find((a) => a.asset?.toLowerCase() === asset.toLowerCase());
    if (!pick) throw new Error(`gateway does not accept ${asset}`);
    const units = BigInt(pick.amount ?? pick.maxAmountRequired);
    if (units > cap) throw new Error("quote above NEWS_MAX_PER_CALL; nothing signed");
    lastQuotedUsd = Number(units) / 1e6;
    return pick;
  };
  const client = new x402Client(select);
  registerExactEvmScheme(client, { signer: privateKeyToAccount(key), paymentRequirementsSelector: select });
  return wrapFetchWithPayment(fetch, client);
}

async function spentToday(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  return (await readSpend()).filter((e) => String(e.at).startsWith(day)).reduce((s, e) => s + Number(e.usd ?? 0), 0);
}

async function readPosts(id: CorridorId, pay: typeof fetch | null): Promise<{ posts: string[]; receipt: unknown }> {
  if (fixture) {
    const f = JSON.parse(await Deno.readTextFile(fixture));
    return { posts: postTexts(f[id] ?? f), receipt: null };
  }
  const res = await pay!(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERIES[id], type: "latest" }),
  });
  const hdr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`gateway ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { posts: postTexts(body), receipt: hdr ? decodePaymentResponseHeader(hdr) : null };
}

async function poll(pay: typeof fetch | null): Promise<Regime> {
  const now = Math.floor(Date.now() / 1000);
  const regimes = await readRegimes();
  let changed = false;

  for (const id of Object.keys(CORRIDORS) as CorridorId[]) {
    if (!fixture && (await spentToday()) + maxPerCall > dailyBudget) {
      console.error(`daily budget $${dailyBudget} reached; holding ${id} at its current regime`);
      continue;
    }
    let posts: string[], receipt: unknown;
    try {
      ({ posts, receipt } = await readPosts(id, pay));
    } catch (e) {
      // No news is not good news: a failed read leaves the regime where it
      // was rather than relaxing it.
      console.error(`${id}: ${(e as Error).message}`);
      continue;
    }
    const s = score(id, posts);
    const reading = regimeOf(s.score);
    const prev: RegimeState = regimes[id] ?? { regime: "calm", since: now, lastConfirmed: now };
    const nextState = next(prev, reading, now);
    if (nextState.regime !== prev.regime) changed = true;
    regimes[id] = nextState;

    await appendSpend({
      at: new Date().toISOString(),
      corridor: id,
      capability: fixture ? "fixture (unpaid)" : "x.posts.search",
      usd: fixture ? 0 : lastQuotedUsd,
      asset: fixture ? null : asset,
      receipt,
      posts: posts.length,
      score: s.score,
      topHits: s.hits.slice(0, 5),
      reading,
      regime: nextState.regime,
      changedQuoting: nextState.regime !== prev.regime,
    });
    console.log(`${id}: ${posts.length} posts, score ${s.score} → reading ${reading}, regime ${nextState.regime}`);
  }

  await writeJson("regime.json", regimes);

  const missing = await Deno.stat("stitch/stitch.toml").then(() => false, () => true);
  if (changed || missing) {
    const flat = Object.fromEntries(Object.entries(regimes).map(([k, v]) => [k, v!.regime]));
    await Deno.writeTextFile("stitch/stitch.toml", renderStitch(flat, feedBase));
    const cmd = (Deno.env.get("STITCH_RESTART_CMD") ?? "").trim();
    if (cmd) {
      const out = await new Deno.Command("sh", { args: ["-c", cmd] }).output();
      console.log(`stitch restart: exit ${out.code}`);
    } else {
      console.log("stitch.toml rewritten; STITCH_RESTART_CMD is empty, so restart Stitch yourself");
    }
  }

  const rank = { calm: 0, elevated: 1, shock: 2 } as const;
  return Object.values(regimes).reduce<Regime>((w, r) => (r && rank[r.regime] > rank[w] ? r.regime : w), "calm");
}

if (import.meta.main) {
  const pay = fixture ? null : payingFetch();
  do {
    const worst = await poll(pay);
    if (once) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MINS[worst] * 60_000));
  } while (true);
}
