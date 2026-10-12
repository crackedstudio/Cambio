/// What the maker wallet holds, valued at fair price. The skew in
/// `fairvalue.ts` leans the quote toward rebalancing this.

import { createPublicClient, http, parseAbi } from "viem";
import { type Corridor, RPC, USDT } from "./config.ts";

const pub = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export type Inventory = { usdt: number; local: number; localShare: number };

/// `rate` is local units per USD (fair value), used to put both sides in
/// dollars. `localShare` is the share of the value held in the local token —
/// 0.5 is balanced.
export async function inventory(maker: `0x${string}`, c: Corridor, rate: number): Promise<Inventory> {
  const [u, l] = await Promise.all([
    pub.readContract({ address: USDT.address, abi: erc20, functionName: "balanceOf", args: [maker] }),
    pub.readContract({ address: c.token.address, abi: erc20, functionName: "balanceOf", args: [maker] }),
  ]);
  const usdt = Number(u) / 10 ** USDT.decimals;
  const local = Number(l) / 10 ** c.token.decimals;
  const localUsd = local / rate;
  const total = usdt + localUsd;
  return { usdt, local, localShare: total > 0 ? localUsd / total : 0.5 };
}
