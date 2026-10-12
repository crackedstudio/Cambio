/// The public evidence page (roadmap 4.1), served by the feed at /dashboard,
/// with its data at /api/dashboard. Built only from files the bot already
/// writes — pnl.json, equity.jsonl, spend.jsonl, regime.json — so it can show
/// nothing the ledger and the spend log cannot back up.
///
/// No libraries, no external requests: one HTML page, an inline SVG curve,
/// light and dark. It refreshes itself every 60 seconds.

import { readJson, readRegimes, readSpend } from "./state.ts";

type Pnl = {
  asOf: string; maker: string; fills: number; volumeFilledUsd: number; edgeUsd: number;
  dataCostUsd: number; equityUsd: number; baselineEquityUsd: number; totalPnlUsd: number; dayPnlUsd: number;
  recentFills: Array<{ tx: string; corridor: string; side: string; usdt: number; local: number; rate: number; poolRate: number | null; edgeUsd: number | null }>;
};

async function equityHistory(): Promise<Array<{ at: string; equityUsd: number }>> {
  try {
    return (await Deno.readTextFile("state/equity.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function dashboardData() {
  const [pnl, history, spend, regimes] = await Promise.all([
    readJson<Pnl | null>("pnl.json", null), equityHistory(), readSpend(), readRegimes(),
  ]);
  const calls = spend.filter((e) => e.kind !== "decision" && Number(e.usd ?? 0) > 0);
  const byCapability: Record<string, { calls: number; usd: number }> = {};
  for (const c of calls) {
    const k = String(c.capability);
    byCapability[k] ??= { calls: 0, usd: 0 };
    byCapability[k].calls++;
    byCapability[k].usd += Number(c.usd);
  }
  const decisions = spend.filter((e) => e.kind === "decision");
  // Regime timeline: only the decisions that changed quoting, newest first.
  const changes = decisions.filter((d) => d.changedQuoting).reverse().slice(0, 30);
  return {
    pnl,
    equity: history.slice(-500),
    data: {
      calls: calls.length,
      usd: Math.round(calls.reduce((s, c) => s + Number(c.usd), 0) * 1e4) / 1e4,
      byCapability,
      recentReceipts: calls.slice(-10).reverse().map((c) => ({ at: c.at, capability: c.capability, receipt: c.receipt })),
    },
    regimes,
    regimeChanges: changes,
    polls: decisions.length,
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const usd = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(dp)}`);
const txLink = (h: string) => `<a href="https://celoscan.io/tx/${esc(h)}">${esc(h.slice(0, 10))}…</a>`;

function curve(points: Array<{ equityUsd: number }>): string {
  if (points.length < 2) return `<p class="muted">The equity curve appears after the ledger's second run.</p>`;
  const w = 640, h = 160, pad = 8;
  const ys = points.map((p) => p.equityUsd);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const d = points.map((p, i) => `${i ? "L" : "M"}${(pad + (i * (w - 2 * pad)) / (points.length - 1)).toFixed(1)},${(h - pad - ((p.equityUsd - lo) * (h - 2 * pad)) / span).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Equity from ${usd(lo)} to ${usd(hi)}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>
  <p class="muted">${usd(lo)} – ${usd(hi)} over ${points.length} readings</p>`;
}

export async function dashboardHtml(status: unknown): Promise<string> {
  const d = await dashboardData();
  const p = d.pnl;
  const tiles = p
    ? [
      ["Net P&L", usd(p.totalPnlUsd, 4), "equity change minus data cost"],
      ["Volume filled", usd(p.volumeFilledUsd), `${p.fills} fills`],
      ["Edge vs pool", usd(p.edgeUsd, 4), "spread earned, picked-off fills subtracted"],
      ["Data paid (x402)", usd(d.data.usd, 4), `${d.data.calls} paid call${d.data.calls === 1 ? "" : "s"}`],
      ["Equity", usd(p.equityUsd), `baseline ${usd(p.baselineEquityUsd)}`],
      ["Today", usd(p.dayPnlUsd), "loss halt at −$15"],
    ]
    : [["Waiting for the ledger", "—", "run `deno task ledger`"]];
  const corridors = ((status as { corridors?: Array<Record<string, unknown>> })?.corridors ?? []).map((c) => {
    const fv = c.fairValue as { ok: boolean; rate?: number; used?: Array<{ source: string; rate: number }> };
    return `<tr><td>${esc(c.corridor)}</td><td>${esc(c.regime)}</td><td>${c.publish ? "quoting" : `<b>withheld</b>: ${esc(c.reason)}`}</td>
      <td>${fv?.ok ? Number(fv.rate).toFixed(4) : "—"}</td><td class="muted">${esc((fv?.used ?? []).map((u) => `${u.source} ${Number(u.rate).toFixed(2)}`).join(" · "))}</td></tr>`;
  }).join("");
  const fills = (p?.recentFills ?? []).slice().reverse().map((f) =>
    `<tr><td>${txLink(f.tx)}</td><td>${esc(f.corridor)}</td><td>${esc(f.side)}</td><td>${f.usdt.toFixed(2)}</td><td>${f.rate.toFixed(4)}</td><td>${f.poolRate?.toFixed(4) ?? "—"}</td><td class="${(f.edgeUsd ?? 0) < 0 ? "neg" : ""}">${usd(f.edgeUsd, 4)}</td></tr>`
  ).join("");
  const changes = d.regimeChanges.map((c) => {
    const hits = (c.topHits as Array<{ term: string; post: string }> | undefined) ?? [];
    return `<li><b>${esc(c.corridor)} → ${esc(c.regime)}</b> <span class="muted">${esc(String(c.at).slice(0, 16).replace("T", " "))} UTC · score ${esc(c.score)}</span>
      ${hits.length ? `<ul>${hits.slice(0, 3).map((h) => `<li><code>${esc(h.term)}</code> “${esc(h.post)}”</li>`).join("")}</ul>` : ""}</li>`;
  }).join("");
  const receipts = d.data.recentReceipts.map((r) => {
    const tx = (r.receipt as { transaction?: string } | null)?.transaction;
    return `<li>${esc(String(r.at).slice(0, 16).replace("T", " "))} · ${esc(r.capability)} · ${tx ? txLink(tx) : "no receipt"}</li>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Cambio</title>
<style>
:root{--bg:#f7f7f4;--fg:#1b1d1a;--muted:#6b6f68;--card:#fff;--line:#e3e3dc;--accent:#1d7a5f;--neg:#b3412f}
@media (prefers-color-scheme:dark){:root{--bg:#121412;--fg:#e8e9e4;--muted:#9a9e96;--card:#1b1e1b;--line:#2c302b;--accent:#5cc79f;--neg:#ff8a73}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0;font-size:26px}h2{font-size:17px;margin:32px 0 10px}
.muted{color:var(--muted)}.neg{color:var(--neg)}a{color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tile b{display:block;font-size:22px;margin:2px 0}.tile span{font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
svg{width:100%;height:auto}ul{padding-left:18px}li{margin:6px 0}code{font-size:13px}
</style></head><body><main>
<h1>Cambio</h1>
<p class="muted">News-aware market maker for LatAm stablecoins on Celo · Textile FX · maker ${esc(p?.maker ?? "—")} · ${esc(p?.asOf ?? "")}</p>
<div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><span class="muted">${esc(k)}</span><b>${esc(v)}</b><span class="muted">${esc(s)}</span></div>`).join("")}</div>
<h2>Equity</h2><div class="card">${curve(d.equity)}</div>
<h2>Feeds right now</h2><div class="card"><table><tr><th>Corridor</th><th>Regime</th><th>Stitch</th><th>Fair (local/USD)</th><th>Sources</th></tr>${corridors || `<tr><td colspan="5" class="muted">feed status unavailable</td></tr>`}</table></div>
<h2>What the news changed</h2><div class="card">${changes ? `<ul>${changes}</ul>` : `<p class="muted">No regime change yet across ${d.polls} polls.</p>`}</div>
<h2>Fills</h2><div class="card"><table><tr><th>Tx</th><th>Corridor</th><th>Side</th><th>USDT</th><th>Rate</th><th>Pool</th><th>Edge</th></tr>${fills || `<tr><td colspan="7" class="muted">No fills yet.</td></tr>`}</table></div>
<h2>Paid calls (x402 on Celo)</h2><div class="card">
<p>${d.data.calls} call${d.data.calls === 1 ? "" : "s"}, ${usd(d.data.usd, 4)} — ${Object.entries(d.data.byCapability).map(([k, v]) => `${esc(k)}: ${v.calls}`).join(" · ") || "none yet"}</p>
${receipts ? `<ul>${receipts}</ul>` : ""}</div>
<p class="muted">Data: <a href="/api/dashboard">/api/dashboard</a> · <a href="/status">/status</a> · <a href="https://github.com/crackedstudio/Cambio">source</a></p>
</main></body></html>`;
}
