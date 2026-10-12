/// P&L and volume, from the chain — the numbers the Textile judges score.
///
///   deno task ledger            # scan new blocks, write state/pnl.json, enforce the loss limit
///   deno task ledger --watch    # every 2 minutes
///
/// A fill is a UniswapX `Fill(orderHash, filler, swapper, nonce)` on Textile's
/// reactor where `swapper` is our maker (verified on Celo 2026-10-12). Its
/// amounts are the token transfers to and from the maker in that transaction.
///
/// Three numbers, kept apart because they answer different questions:
///   - **edge**: each fill valued against the Uniswap pool's price AT THAT
///     BLOCK. Positive = we earned spread; negative = we were picked off.
///     The first fill seen while building this (0x059102b0…) was a taker
///     buying a maker's wARS and selling them into the pool in the same
///     transaction for $0.17 — negative edge for that maker, measured exactly
///     this way.
///   - **data cost**: what the news agent paid, from state/spend.jsonl.
///   - **equity**: everything the maker holds at today's fair value, against a
///     baseline taken at first run. The honest bottom line — it includes the
///     inventory moving with the peso, which edge alone hides.

import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { CORRIDORS, type Corridor, RISK, RPC, TEXTILE, UNISWAP_QUOTER, USDT } from "./config.ts";
import { readJson, readSpend, writeJson } from "./state.ts";

const pub = createPublicClient({ transport: http(RPC) });
const MAKER = (Deno.env.get("MAKER_ADDRESS") ?? "").toLowerCase() as `0x${string}`;
const START_BLOCK = BigInt(Deno.env.get("LEDGER_START_BLOCK") ?? "0");
const CHUNK = 5000n; // forno's eth_getLogs range limit

const FILL = parseAbiItem("event Fill(bytes32 indexed orderHash, address indexed filler, address indexed swapper, uint256 nonce)");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

type FillRow = {
  tx: string;
  block: string;
  corridor: string;
  side: "sold-local" | "bought-local";
  usdt: number;
  local: number;
  /// Local units per USD the fill happened at.
  rate: number;
  /// Pool's local-per-USD at that block.
  poolRate: number | null;
  edgeUsd: number | null;
};

type LedgerState = { cursor: string; fills: FillRow[]; baseline: { at: string; equityUsd: number } | null };

const corridorOf = (token: string): Corridor | undefined =>
  Object.values(CORRIDORS).find((c) => c.token.address.toLowerCase() === token.toLowerCase());

async function poolRate(c: Corridor, block: bigint): Promise<number | null> {
  try {
    const { result } = await pub.simulateContract({
      address: UNISWAP_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", blockNumber: block,
      args: [{ tokenIn: USDT.address, tokenOut: c.token.address, amountIn: 10n ** BigInt(USDT.decimals), fee: c.poolFee, sqrtPriceLimitX96: 0n }],
    });
    return Number(result[0]) / 10 ** c.token.decimals;
  } catch {
    return null;
  }
}

async function fillsIn(from: bigint, to: bigint): Promise<FillRow[]> {
  const logs = await pub.getLogs({ address: TEXTILE.reactor, event: FILL, args: { swapper: MAKER }, fromBlock: from, toBlock: to });
  const rows: FillRow[] = [];
  for (const log of logs) {
    const rc = await pub.getTransactionReceipt({ hash: log.transactionHash! });
    let usdtIn = 0n, usdtOut = 0n, localIn = 0n, localOut = 0n;
    let c: Corridor | undefined;
    for (const l of rc.logs) {
      if (l.topics[0] !== TRANSFER) continue;
      const from = ("0x" + l.topics[1]!.slice(26)).toLowerCase();
      const to = ("0x" + l.topics[2]!.slice(26)).toLowerCase();
      if (from !== MAKER && to !== MAKER) continue;
      const v = BigInt(l.data);
      const token = l.address.toLowerCase();
      const local = corridorOf(token);
      if (token === USDT.address.toLowerCase()) {
        if (to === MAKER) usdtIn += v;
        else usdtOut += v;
      } else if (local) {
        c = local;
        if (to === MAKER) localIn += v;
        else localOut += v;
      }
    }
    if (!c) continue;
    const soldLocal = localOut > localIn;
    const usdt = Number(soldLocal ? usdtIn - usdtOut : usdtOut - usdtIn) / 10 ** USDT.decimals;
    const local = Number(soldLocal ? localOut - localIn : localIn - localOut) / 10 ** c.token.decimals;
    if (!(usdt > 0 && local > 0)) continue;
    const rate = local / usdt;
    const pr = await poolRate(c, log.blockNumber!);
    // Edge in dollars against the pool: selling pesos, a LOWER local-per-USD
    // than the pool is good (we gave fewer pesos per dollar); buying pesos, a
    // HIGHER one is good (we got more pesos per dollar).
    const edgeUsd = pr === null ? null : soldLocal ? usdt - local / pr : local / pr - usdt;
    rows.push({
      tx: log.transactionHash!, block: log.blockNumber!.toString(), corridor: c.id,
      side: soldLocal ? "sold-local" : "bought-local", usdt, local, rate,
      poolRate: pr, edgeUsd: edgeUsd === null ? null : Math.round(edgeUsd * 1e4) / 1e4,
    });
  }
  return rows;
}

async function equityUsd(): Promise<number> {
  const usdt = Number(await pub.readContract({ address: USDT.address, abi: erc20, functionName: "balanceOf", args: [MAKER] })) / 10 ** USDT.decimals;
  let total = usdt;
  for (const c of Object.values(CORRIDORS)) {
    const bal = Number(await pub.readContract({ address: c.token.address, abi: erc20, functionName: "balanceOf", args: [MAKER] })) / 10 ** c.token.decimals;
    const pr = await poolRate(c, await pub.getBlockNumber());
    if (bal > 0 && pr) total += bal / pr;
  }
  return total;
}

async function run() {
  if (!/^0x[0-9a-f]{40}$/.test(MAKER)) throw new Error("MAKER_ADDRESS is not set");
  const st = await readJson<LedgerState>("ledger.json", { cursor: START_BLOCK.toString(), fills: [], baseline: null });
  const head = await pub.getBlockNumber();
  let from = BigInt(st.cursor) || head - CHUNK;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    st.fills.push(...(await fillsIn(from, to)));
    from = to + 1n;
    st.cursor = from.toString();
  }

  const equity = await equityUsd();
  st.baseline ??= { at: new Date().toISOString(), equityUsd: equity };
  const dataCost = (await readSpend()).reduce((s, e) => s + Number(e.usd ?? 0), 0);
  const edge = st.fills.reduce((s, f) => s + (f.edgeUsd ?? 0), 0);
  const volume = st.fills.reduce((s, f) => s + f.usdt, 0);

  const day = new Date().toISOString().slice(0, 10);
  const today = await readJson<{ day: string; startEquity: number }>("today.json", { day: "", startEquity: equity });
  if (today.day !== day) await writeJson("today.json", { day, startEquity: equity });
  const dayPnl = equity - (today.day === day ? today.startEquity : equity);

  // The daily loss limit: the feed reads halt.json and stops publishing until
  // the next UTC midnight. Quotes lapse on Stitch's staleness check.
  if (dayPnl < -RISK.dailyLossLimitUsd) {
    const midnight = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
    await writeJson("halt.json", { haltedUntil: midnight, reason: `day P&L ${dayPnl.toFixed(2)} below -${RISK.dailyLossLimitUsd}` });
  }

  const pnl = {
    asOf: new Date().toISOString(),
    maker: MAKER,
    fills: st.fills.length,
    volumeFilledUsd: Math.round(volume * 100) / 100,
    edgeUsd: Math.round(edge * 1e4) / 1e4,
    dataCostUsd: Math.round(dataCost * 1e4) / 1e4,
    equityUsd: Math.round(equity * 100) / 100,
    baselineEquityUsd: st.baseline.equityUsd,
    totalPnlUsd: Math.round((equity - st.baseline.equityUsd - dataCost) * 1e4) / 1e4,
    dayPnlUsd: Math.round(dayPnl * 100) / 100,
    recentFills: st.fills.slice(-20),
  };
  await writeJson("ledger.json", st);
  await writeJson("pnl.json", pnl);
  console.log(JSON.stringify({ ...pnl, recentFills: pnl.recentFills.length }));
}

if (import.meta.main) {
  do {
    try {
      await run();
    } catch (e) {
      console.error("ledger:", (e as Error).message);
    }
    if (!Deno.args.includes("--watch")) break;
    await new Promise((r) => setTimeout(r, 120_000));
  } while (true);
}
