/// Fair value: several prices in, one price (or a refusal) out. Pure — no I/O —
/// so every rule here is pinned by `test/fairvalue.test.ts`.
///
/// Everything inside is in LOCAL units per USD (1602 wARS per dollar), the way
/// every source quotes it. Only `toStitchPrice` turns it around, because
/// Stitch wants **debt per collateral** — USDT per wARS, ≈ 0.000624. Its docs
/// are blunt about the inverse: publishing 1602 makes the bot post wildly
/// mispriced orders. One conversion, at the edge, tested.

import { RISK } from "./config.ts";

export type Quote = {
  source: string;
  /// Local units per 1 USD.
  rate: number;
  /// Unix seconds when the source last updated.
  at: number;
};

export type FairValue =
  | { ok: true; rate: number; used: Quote[]; dropped: Quote[]; spreadBps: number }
  | { ok: false; reason: string; used: Quote[]; dropped: Quote[] };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const bpsApart = (a: number, b: number) => (Math.abs(a - b) / ((a + b) / 2)) * 10_000;

/// Median of fresh sources, outliers removed, refused when what remains does
/// not agree. A refusal is the safe answer: the feed then serves nothing,
/// Stitch's staleness check stops quoting, and no money moves on a guess.
export function fairValue(quotes: Quote[], now: number, risk = RISK): FairValue {
  const fresh = quotes.filter((q) => q.rate > 0 && Number.isFinite(q.rate) && now - q.at <= risk.maxSourceAgeSecs);
  const stale = quotes.filter((q) => !fresh.includes(q));
  if (fresh.length < risk.minSources) {
    return { ok: false, reason: `only ${fresh.length} fresh source(s)`, used: fresh, dropped: stale };
  }
  const mid = median(fresh.map((q) => q.rate));
  const used = fresh.filter((q) => bpsApart(q.rate, mid) <= risk.outlierBps);
  const dropped = [...stale, ...fresh.filter((q) => !used.includes(q))];
  if (used.length < risk.minSources) {
    return { ok: false, reason: `sources disagree; ${used.length} near the median`, used, dropped };
  }
  const rates = used.map((q) => q.rate);
  const spreadBps = bpsApart(Math.max(...rates), Math.min(...rates));
  if (spreadBps > risk.maxDisagreementBps) {
    return { ok: false, reason: `sources ${Math.round(spreadBps)} bps apart`, used, dropped };
  }
  return { ok: true, rate: median(rates), used, dropped, spreadBps: Math.round(spreadBps) };
}

/// Shift the mid toward unloading whatever we hold too much of.
///
/// `localShare` is the share of inventory VALUE held in the local token, 0..1.
/// Balanced is 0.5. Holding too many pesos (share > 0.5) means we want to sell
/// pesos: offer more pesos per dollar — a higher local-per-USD rate — so takers
/// buying pesos come to us. Holding too few, the opposite. Linear, capped at
/// `maxSkewBps` for a fully one-sided book.
export function skew(rate: number, localShare: number, risk = RISK): number {
  const s = Math.min(1, Math.max(0, localShare));
  const tilt = (s - 0.5) * 2; // -1 .. +1
  return rate * (1 + (tilt * risk.maxSkewBps) / 10_000);
}

/// The one number Stitch reads: USDT per local token (debt per collateral).
export function toStitchPrice(localPerUsd: number): number {
  if (!(localPerUsd > 0)) throw new Error("rate must be positive");
  return 1 / localPerUsd;
}
