/// News → regime → how Cambio quotes. Pure; pinned by `test/regime.test.ts`.
///
/// v1 is deliberately a keyword scorer, not a model: every decision it makes
/// can be read back from the posts that caused it, which is what a maker
/// operator (and a judge) needs to trust a rule that widens their spread.
/// A model can replace `score` later; the regime table and its effects stay.

import type { CorridorId } from "./config.ts";

export type Regime = "calm" | "elevated" | "shock";

/// Terms that move a currency, weighted by how hard. Lower-case, accents
/// stripped before matching (see `norm`). Spanish for Argentina, Portuguese
/// for Brazil; English for the international wires both get quoted in.
export const TERMS: Record<CorridorId, Array<[string, number]>> = {
  "wars-usdt": [
    ["devaluacion", 5], ["devalua", 4], ["corrida cambiaria", 5], ["feriado cambiario", 6],
    ["cepo", 3], ["bandas cambiarias", 3], ["salto del dolar", 4], ["dolar se dispara", 4],
    ["dolar blue", 1], ["bcra", 1], ["reservas", 1], ["default", 4], ["argentina devalues", 5],
    ["peso plunges", 5], ["peso slides", 3],
  ],
  "wbrl-usdt": [
    ["dolar dispara", 4], ["real desvaloriza", 4], ["intervencao cambial", 5], ["leilao de dolar", 3],
    ["copom", 2], ["selic", 1], ["banco central", 1], ["crise fiscal", 3], ["real plunges", 5],
    ["brazil real slides", 3], ["arcabouco fiscal", 2],
  ],
};

export const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/// Sum of term weights across posts, each post counted once per term, so one
/// spammy account repeating a word cannot fake a crisis. Returns the score and
/// the posts that contributed, for the log.
export function score(corridor: CorridorId, posts: string[]): { score: number; hits: Array<{ term: string; post: string }> } {
  const hits: Array<{ term: string; post: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of posts) {
    const p = norm(raw);
    const key = p.slice(0, 120); // near-duplicate reposts count once
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [term, w] of TERMS[corridor]) {
      if (p.includes(term)) {
        total += w;
        hits.push({ term, post: raw.slice(0, 200) });
      }
    }
  }
  return { score: total, hits };
}

/// Thresholds on the score from one polling window (the last hour of posts).
/// Starting values: tune from the ledger, not from intuition.
export const THRESHOLDS = { elevated: 12, shock: 30 } as const;

export function regimeOf(s: number): Regime {
  return s >= THRESHOLDS.shock ? "shock" : s >= THRESHOLDS.elevated ? "elevated" : "calm";
}

/// What each regime does to the quote. `offsetMultiplier` widens the spread
/// Stitch posts around fair value; `liquidityShare` caps how much inventory it
/// commits. In `shock` the feed stops publishing — Stitch's staleness check
/// then pulls every quote within `staleness_secs`, with no restart needed.
export const EFFECTS: Record<Regime, { offsetMultiplier: number; liquidityShare: number; publish: boolean }> = {
  calm: { offsetMultiplier: 1, liquidityShare: 1, publish: true },
  elevated: { offsetMultiplier: 3, liquidityShare: 0.5, publish: true },
  shock: { offsetMultiplier: 3, liquidityShare: 0, publish: false },
};

/// A regime only steps DOWN after `coolOffMins` of quieter readings. Stepping
/// up is immediate: the cost of quoting wide for an extra hour is a few lost
/// fills; the cost of quoting tight one tick too early after a shock is the
/// inventory.
///
/// The cool-off counts from the last reading AT OR ABOVE the current regime,
/// not from when the regime began: a shock that lasted three hours must still
/// see a quiet hour before it ends, not one quiet reading.
export type RegimeState = { regime: Regime; since: number; lastConfirmed: number };

export function next(prev: RegimeState, reading: Regime, nowSecs: number, coolOffMins = 60): RegimeState {
  const rank = { calm: 0, elevated: 1, shock: 2 } as const;
  if (rank[reading] > rank[prev.regime]) return { regime: reading, since: nowSecs, lastConfirmed: nowSecs };
  if (rank[reading] === rank[prev.regime]) return { ...prev, lastConfirmed: nowSecs };
  return nowSecs - prev.lastConfirmed >= coolOffMins * 60
    ? { regime: reading, since: nowSecs, lastConfirmed: nowSecs }
    : prev;
}
