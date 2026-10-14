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
import { patchStitch, renderStitch } from "./stitchconf.ts";
import { alert } from "./alerts.ts";

/// Paid sources on the buy gateway, both $0.005 a call (read from each 402).
/// X is on by default; Reddit joins with NEWS_SOURCES=x,reddit (roadmap 3.4).
type Source = { capability: string; url: string; body: (id: CorridorId) => Record<string, unknown> };
const SOURCES: Record<string, Source> = {
  x: {
    capability: "x.posts.search",
    url: "https://gateway.usebuy.ai/v1/social/x/posts/search",
    body: (id) => ({ query: QUERIES[id], type: "latest" }),
  },
  reddit: {
    capability: "reddit.posts.search",
    url: "https://gateway.usebuy.ai/v1/social/reddit/posts/search",
    body: (id) => ({ query: REDDIT_QUERIES[id], type: "post", sort: "new", timeRange: "hour" }),
  },
};
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

/// Reddit search takes plain words, not X operators.
const REDDIT_QUERIES: Record<CorridorId, string> = {
  "wars-usdt": "devaluación dólar BCRA cepo",
  "wbrl-usdt": "dólar real Copom câmbio",
};

const enabledSources = (Deno.env.get("NEWS_SOURCES") ?? "x").split(",").map((x) => x.trim()).filter((x) => SOURCES[x]);

/// Minutes between polls, by the worst regime currently in force.
const INTERVAL_MINS: Record<Regime, number> = { calm: 20, elevated: 5, shock: 5 };

const args = Deno.args;
const once = args.includes("--once");
const fixture = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;

const maxPerCall = Number(Deno.env.get("NEWS_MAX_PER_CALL") ?? "0.01");
const dailyBudget = Number(Deno.env.get("NEWS_DAILY_BUDGET") ?? "1.50");
const asset = ASSETS[(Deno.env.get("NEWS_ASSET") ?? "USAT").toUpperCase()];
const feedBase = (Deno.env.get("FEED_PUBLIC_URL") || "").replace(/\/+$/, "") || `http://127.0.0.1:${Deno.env.get("FEED_PORT") ?? 8787}`;

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

async function readPosts(id: CorridorId, src: Source, pay: typeof fetch | null): Promise<{ posts: string[]; receipt: unknown }> {
  if (fixture) {
    const f = JSON.parse(await Deno.readTextFile(fixture));
    return { posts: postTexts(f[id] ?? f), receipt: null };
  }
  const res = await pay!(src.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(src.body(id)),
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
    // Every enabled source for this corridor, each paid and logged on its
    // own; the posts are scored together. Fixtures read once.
    const posts: string[] = [];
    const paid: Array<{ capability: string; usd: number; receipt: unknown }> = [];
    let failed = false;
    for (const name of fixture ? ["x"] : enabledSources) {
      if (!fixture && (await spentToday()) + maxPerCall > dailyBudget) {
        console.error(`daily budget $${dailyBudget} reached; skipping ${name} for ${id}`);
        failed = true;
        continue;
      }
      try {
        const r = await readPosts(id, SOURCES[name], pay);
        posts.push(...r.posts);
        paid.push({ capability: fixture ? "fixture (unpaid)" : SOURCES[name].capability, usd: fixture ? 0 : lastQuotedUsd, receipt: r.receipt });
      } catch (e) {
        console.error(`${id} ${name}: ${(e as Error).message}`);
        failed = true;
      }
    }
    // No news is not good news: with nothing read, the regime stays where it
    // was rather than relaxing. A partial read can still raise it.
    if (!paid.length) continue;
    const s = score(id, posts);
    const reading = regimeOf(s.score);
    const prev: RegimeState = regimes[id] ?? { regime: "calm", since: now, lastConfirmed: now };
    // A partial read may raise the regime but never lower it: the source that
    // failed might be the one that saw the news.
    const rank = { calm: 0, elevated: 1, shock: 2 } as const;
    const nextState = failed && rank[reading] < rank[prev.regime] ? prev : next(prev, reading, now);
    if (nextState.regime !== prev.regime) changed = true;
    regimes[id] = nextState;

    // One line per paid call — the demand the buy judges count — then one
    // "decision" line saying what those calls changed.
    for (const call of paid) {
      await appendSpend({
        at: new Date().toISOString(),
        corridor: id,
        capability: call.capability,
        usd: call.usd,
        asset: fixture ? null : asset,
        receipt: call.receipt,
      });
    }
    await appendSpend({
      at: new Date().toISOString(),
      corridor: id,
      kind: "decision",
      usd: 0,
      sources: paid.map((c) => c.capability),
      posts: posts.length,
      score: s.score,
      topHits: s.hits.slice(0, 5),
      reading,
      regime: nextState.regime,
      changedQuoting: nextState.regime !== prev.regime,
    });
    console.log(`${id}: ${posts.length} posts, score ${s.score} → reading ${reading}, regime ${nextState.regime}`);
    if (nextState.regime !== prev.regime) {
      await alert("regime", `regime:${id}`, nextState.regime,
        `${id}: regime ${prev.regime} → ${nextState.regime} (score ${s.score}; e.g. "${s.hits[0]?.post.slice(0, 90) ?? "—"}")`);
    }
  }

  await writeJson("regime.json", regimes);

  const missing = await Deno.stat("stitch/stitch.toml").then(() => false, () => true);
  if (changed || missing) {
    const flat = Object.fromEntries(Object.entries(regimes).map(([k, v]) => [k, v!.regime]));
    await applyToStitch(flat, feedBase);
  }

  const rank = { calm: 0, elevated: 1, shock: 2 } as const;
  return Object.values(regimes).reduce<Regime>((w, r) => (r && rank[r.regime] > rank[w] ? r.regime : w), "calm");
}

/// Put the regimes into Stitch's config and restart the bot.
///
/// With the panel (the normal setup), the panel owns the bot's stitch.toml:
/// STITCH_PULL_CMD copies the live file to stitch/live.toml, Cambio patches
/// only its own keys into stitch/stitch.toml, and STITCH_RESTART_CMD installs
/// it — refusing if the panel changed the file in between — and restarts the
/// bot. Without a pull command, the whole file is generated (bot set up by
/// hand). Either command empty = write the file and tell the operator.
async function applyToStitch(regimes: Partial<Record<CorridorId, Regime>>, feedBase: string) {
  const sh = async (name: string) => {
    const cmd = (Deno.env.get(name) ?? "").trim();
    if (!cmd) return null;
    const out = await new Deno.Command("sh", { args: ["-c", cmd] }).output();
    const say = new TextDecoder().decode(out.stderr).trim() || new TextDecoder().decode(out.stdout).trim();
    console.log(`${name}: exit ${out.code}${say ? ` — ${say}` : ""}`);
    return out.code;
  };

  const pulled = await sh("STITCH_PULL_CMD");
  if (pulled !== null && pulled !== 0) {
    // Never fall back to generating a whole file over the panel's.
    await alert("stitch", "stitch:pull", `fail:${pulled}`, `Could not read the bot's config (exit ${pulled}); regime change NOT applied. The feed still enforces shock.`);
    return;
  }
  const live = pulled === 0 ? await Deno.readTextFile("stitch/live.toml").catch(() => "") : "";
  let text: string;
  if (/^\s*\[\[pools\]\]/m.test(live)) {
    const { text: patched, report } = patchStitch(live, regimes, feedBase);
    text = patched;
    console.log(`stitch.toml patched: ${report.patched.join(", ") || "no pools"}${report.missing.length ? `; not in the bot: ${report.missing.join(", ")} (add the corridor in the panel)` : ""}`);
    for (const w of report.warnings) {
      console.warn(`stitch.toml: ${w}`);
      await alert("stitch", `stitch:warn:${w.split(":")[0]}`, w, `Stitch config: ${w}`).catch(() => {});
    }
  } else {
    const existing = await Deno.readTextFile("stitch/stitch.toml").catch(() => "");
    text = renderStitch(regimes, feedBase, existing);
  }
  await Deno.writeTextFile("stitch/stitch.toml", text);
  if ((await sh("STITCH_RESTART_CMD")) === null) {
    console.log("stitch/stitch.toml written; STITCH_RESTART_CMD is empty, so install it and restart Stitch yourself");
  }
}

if (import.meta.main) {
  const pay = fixture ? null : payingFetch();
  do {
    const worst = await poll(pay);
    if (once) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MINS[worst] * 60_000));
  } while (true);
}
