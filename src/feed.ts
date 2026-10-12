/// The price feed Stitch polls — one URL per corridor:
///
///   GET /feed/wars-usdt  → { "price": 0.000624, "timestamp": 1760000000 }
///   GET /status          → everything behind those numbers, for humans
///
/// `price` is DEBT PER COLLATERAL — USDT per wARS — as Stitch requires.
///
/// The feed is also Cambio's off switch. It answers 503 (and Stitch, seeing no
/// fresh price within `staleness_secs`, stops quoting) when:
///   - the sources are too few or disagree (`fairValue` refuses);
///   - the news regime is `shock`;
///   - the day's loss limit has been hit (`state/halt.json`).
/// Pulling quotes needs no restart and no second process to be alive: a feed
/// that cannot vouch for a price simply does not publish one.

import { CORRIDORS, type CorridorId } from "./config.ts";
import { fairValue, skew, toStitchPrice } from "./fairvalue.ts";
import { inventory } from "./inventory.ts";
import { EFFECTS } from "./regime.ts";
import { collect } from "./sources.ts";
import { readHalt, readRegimes } from "./state.ts";
import { alert } from "./alerts.ts";

const MAKER = (Deno.env.get("MAKER_ADDRESS") ?? "") as `0x${string}`;
const PORT = Number(Deno.env.get("FEED_PORT") ?? 8787);

/// Sources are polled at most every 10s per corridor; Stitch may poll faster.
const CACHE_MS = 10_000;
const cache = new Map<CorridorId, { at: number; body: Record<string, unknown> }>();

async function price(id: CorridorId) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  const c = CORRIDORS[id];
  const now = Math.floor(Date.now() / 1000);
  const [{ quotes, failed }, regimes, halt] = await Promise.all([collect(c), readRegimes(), readHalt()]);
  const fv = fairValue(quotes, now);
  const regime = regimes[id]?.regime ?? "calm";

  let body: Record<string, unknown> = { corridor: id, regime, fairValue: fv, failedSources: failed };
  let publish = fv.ok && EFFECTS[regime].publish && !(halt.haltedUntil && halt.haltedUntil > now);
  let reason = !fv.ok ? fv.reason : !EFFECTS[regime].publish ? `regime ${regime}` : halt.haltedUntil && halt.haltedUntil > now ? `halted: ${halt.reason}` : null;

  if (publish && fv.ok) {
    let localShare = 0.5;
    if (/^0x[0-9a-fA-F]{40}$/.test(MAKER)) {
      try {
        const inv = await inventory(MAKER, c, fv.rate);
        localShare = inv.localShare;
        body.inventory = inv;
      } catch (e) {
        // Without balances we cannot skew; quoting unskewed is safe, Stitch
        // itself never quotes beyond what the wallet holds.
        body.inventoryError = (e as Error).message;
      }
    }
    const skewed = skew(fv.rate, localShare);
    body = { ...body, localPerUsd: skewed, price: toStitchPrice(skewed), timestamp: now };
  } else {
    publish = false;
    reason = reason ?? "no price";
  }
  body = { ...body, publish, reason };
  cache.set(id, { at: Date.now(), body });
  // Once per transition, not per poll (alerts.ts de-duplicates on the value).
  void alert(
    publish ? "feed-up" : "feed-down", `feed:${id}`, publish ? "up" : `down:${reason}`,
    publish ? `${id}: quoting again` : `${id}: feed withholding price — ${reason}. Stitch stops quoting within staleness_secs.`,
  ).catch(() => {});
  return body;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/feed\/(wars-usdt|wbrl-usdt)$/);
  if (m) {
    const b = await price(m[1] as CorridorId);
    // Exactly the two fields Stitch reads, nothing it could misread.
    return b.publish
      ? Response.json({ price: b.price, timestamp: b.timestamp })
      : Response.json({ error: b.reason }, { status: 503 });
  }
  if (url.pathname === "/status") {
    const all = await Promise.all((Object.keys(CORRIDORS) as CorridorId[]).map(price));
    return Response.json({ corridors: all, halt: await readHalt() });
  }
  return Response.json({ feeds: ["/feed/wars-usdt", "/feed/wbrl-usdt"], status: "/status" }, { status: 404 });
});
