/// Where prices come from. Each source returns local units per USD, or nothing.
/// A failing source is dropped, never retried into a stale number; the blend
/// in `fairvalue.ts` decides whether what is left is enough to quote on.
///
/// **The peso anchor is the crypto/CCL dollar, not the official rate.**
/// Measured 2026-10-12: wARS on Celo traded at ~1,602 per dollar while the
/// official wholesale rate was 1,512 — 6% apart — and the "cripto" (1,605) and
/// "contado con liqui" (1,606) rates sat right on top of it. Anchoring on the
/// official rate would misprice every fill by 6%. The official and MEP rates
/// are not used for pricing at all; they belong in a regime signal, not a mid.
///
/// Brazil has no such gap: wBRL tracks the market rate and Banco Central's
/// PTAX closely.

import { createPublicClient, http, parseAbi } from "viem";
import { type Corridor, RPC, TEXTILE, UNISWAP_QUOTER, USDT } from "./config.ts";
import type { Quote } from "./fairvalue.ts";

const pub = createPublicClient({ transport: http(RPC) });
const now = () => Math.floor(Date.now() / 1000);
const get = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
};

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
]);

/// What the Celo pool pays for `usd` dollars. Priced at a modest size, not at
/// $1, so the number includes the depth we would actually meet.
export async function uniswap(c: Corridor, usd = 50): Promise<Quote> {
  const amountIn = BigInt(Math.round(usd * 10 ** USDT.decimals));
  const { result } = await pub.simulateContract({
    address: UNISWAP_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: USDT.address, tokenOut: c.token.address, amountIn, fee: c.poolFee, sqrtPriceLimitX96: 0n }],
  });
  return { source: "uniswap-celo", rate: Number(result[0]) / 10 ** c.token.decimals / usd, at: now() };
}

/// Textile's own ticker: the mid of the makers' bid and ask. Used as one vote,
/// never alone — it is partly other makers' prices, and a maker anchored only
/// on its competitors has no view of its own.
export async function textile(c: Corridor): Promise<Quote> {
  const rows = (await get(TEXTILE.tickers)) as Array<Record<string, string>>;
  const r = rows.find((x) => x.ticker_id === c.ticker);
  const bid = Number(r?.bid), ask = Number(r?.ask);
  if (!(bid > 0 && ask > 0)) throw new Error(`${c.ticker}: one-sided book`);
  return { source: "textile-ticker", rate: (bid + ask) / 2, at: now() };
}

/// dolarapi.com — Argentina's parallel dollar rates. `casa` is "cripto" or
/// "contadoconliqui"; the mid of compra/venta.
export async function dolarapi(casa: "cripto" | "contadoconliqui"): Promise<Quote> {
  const d = await get(`https://dolarapi.com/v1/dolares/${casa}`);
  const rate = (Number(d.compra) + Number(d.venta)) / 2;
  // Published, not streamed: seen updating at intervals of an hour or more
  // (12 Oct 2026), so a 15-minute freshness rule dropped the peso anchor
  // entirely. The outlier and disagreement checks still guard it.
  return { source: `dolarapi-${casa}`, rate, at: Math.floor(Date.parse(d.fechaActualizacion) / 1000), maxAgeSecs: 3 * 3600 };
}

/// Live USD/BRL (AwesomeAPI), the mid of bid/ask.
export async function awesomeBrl(): Promise<Quote> {
  const d = (await get("https://economia.awesomeapi.com.br/json/last/USD-BRL")).USDBRL;
  return { source: "awesomeapi-usdbrl", rate: (Number(d.bid) + Number(d.ask)) / 2, at: Number(d.timestamp), maxAgeSecs: 3600 };
}

/// Banco Central do Brasil PTAX for today (or the last business day). Slow —
/// published a few times a day — so it carries the "where is the real
/// anchored" vote, and the freshness rule drops it when it is old.
export async function ptax(): Promise<Quote> {
  for (let back = 0; back < 5; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    const mmddyyyy = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
    const url = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/" +
      `CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${mmddyyyy}'&$format=json`;
    const v = (await get(url)).value?.at(-1);
    if (v) {
      return {
        source: "bcb-ptax",
        maxAgeSecs: 6 * 3600,
        rate: (Number(v.cotacaoCompra) + Number(v.cotacaoVenda)) / 2,
        // "2026-10-09 13:07:30.746" is Brasília time (UTC-3).
        at: Math.floor(Date.parse(v.dataHoraCotacao.replace(" ", "T").slice(0, 19) + "-03:00") / 1000),
      };
    }
  }
  throw new Error("no PTAX in the last 5 days");
}

/// Every source for a corridor, settled in parallel; failures are reported
/// alongside, not thrown, so `/status` can say which one is down.
export async function collect(c: Corridor): Promise<{ quotes: Quote[]; failed: string[] }> {
  const jobs: Array<[string, () => Promise<Quote>]> = c.currency === "ARS"
    ? [["uniswap-celo", () => uniswap(c)], ["textile-ticker", () => textile(c)], ["dolarapi-cripto", () => dolarapi("cripto")], ["dolarapi-contadoconliqui", () => dolarapi("contadoconliqui")]]
    : [["uniswap-celo", () => uniswap(c)], ["textile-ticker", () => textile(c)], ["awesomeapi-usdbrl", awesomeBrl], ["bcb-ptax", ptax]];
  const settled = await Promise.allSettled(jobs.map(([, f]) => f()));
  const quotes: Quote[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => (s.status === "fulfilled" ? quotes.push(s.value) : failed.push(`${jobs[i][0]}: ${s.reason?.message ?? s.reason}`)));
  return { quotes, failed };
}
