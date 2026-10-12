/// Everything Cambio quotes, and every number its risk decisions turn on.
///
/// Addresses verified on Celo mainnet 2026-10-12. Thresholds are starting
/// points: tune them from the ledger once the bot has traded, not before.

export const CHAIN_ID = 42220;
export const RPC = Deno.env.get("CELO_RPC_URL") ?? "https://forno.celo.org";

export const USDT = { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 } as const;

/// Textile FX on Celo. The reactor settles fills; Permit2 is what Stitch spends
/// through (`stitch approve`).
export const TEXTILE = {
  indexer: "https://api.textilecredit.com",
  tickers: "https://api.textilecredit.com/tickers",
  reactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

export const UNISWAP_QUOTER = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8";

export type CorridorId = "wars-usdt" | "wbrl-usdt";

export type Corridor = {
  id: CorridorId;
  /// The "soft" side — Stitch calls it collateral.
  token: { symbol: string; address: `0x${string}`; decimals: number };
  currency: "ARS" | "BRL";
  /// Textile's ticker for this pair (local units per USDT).
  ticker: string;
  /// Uniswap v3 USDT pool on Celo.
  poolFee: number;
  /// Stitch spread in calm conditions, bps from the fair price on each side.
  baseOffsetBps: number;
  /// Hard caps on what Stitch may commit per side in calm conditions — below
  /// the wallet balance on purpose ("start wide and small", Textile's advice).
  /// Buying the local token spends USDT; selling it spends the local token.
  buyCapUsdt: number;
  sellCapLocal: number;
};

export const CORRIDORS: Record<CorridorId, Corridor> = {
  "wars-usdt": {
    id: "wars-usdt",
    token: { symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18 },
    currency: "ARS",
    ticker: "USDT_WARS",
    poolFee: 100,
    baseOffsetBps: 15,
    buyCapUsdt: 75,
    sellCapLocal: 120_000,
  },
  "wbrl-usdt": {
    id: "wbrl-usdt",
    token: { symbol: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18 },
    currency: "BRL",
    ticker: "USDT_WBRL",
    poolFee: 100,
    baseOffsetBps: 12,
    buyCapUsdt: 50,
    sellCapLocal: 250,
  },
};

export const RISK = {
  /// Sources more than this far from the median are dropped as outliers.
  outlierBps: 150,
  /// After dropping outliers, fewer than this many sources → no price.
  minSources: 2,
  /// Surviving sources spread wider than this → no price. Two honest markets
  /// that disagree this much mean one of them knows something; quoting into
  /// that is how a maker gets picked off.
  maxDisagreementBps: 120,
  /// A source older than this is ignored.
  maxSourceAgeSecs: 15 * 60,
  /// Inventory skew: at a 100% one-sided book, shift the mid by this much,
  /// toward making the overweight side cheaper to take off our hands.
  maxSkewBps: 25,
  /// Stop quoting entirely after losing this much in a UTC day (dollars).
  dailyLossLimitUsd: 15,
} as const;
