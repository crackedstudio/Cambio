import { assert, assertStringIncludes } from "@std/assert";
import { renderStitch } from "../src/stitchconf.ts";

Deno.test("one pool per corridor, each on its own feed URL", () => {
  const t = renderStitch({}, "http://127.0.0.1:8787");
  assertStringIncludes(t, 'feed_url = "http://127.0.0.1:8787/feed/wars-usdt"');
  assertStringIncludes(t, 'feed_url = "http://127.0.0.1:8787/feed/wbrl-usdt"');
  assertStringIncludes(t, "chain_id = 42220");
});

Deno.test("elevated widens the spread and halves the size", () => {
  const calm = renderStitch({ "wars-usdt": "calm" }, "x");
  const hot = renderStitch({ "wars-usdt": "elevated" }, "x");
  assertStringIncludes(calm, "buy_offset_bps = 15");
  assertStringIncludes(hot, "buy_offset_bps = 45");
  // 75 USDT calm → 37.5 USDT elevated, in 6dp atomic units.
  assertStringIncludes(calm, 'buy_total_liquidity_debt = "75000000"');
  assertStringIncludes(hot, 'buy_total_liquidity_debt = "37500000"');
});

Deno.test("18dp amounts are exact integers", () => {
  const t = renderStitch({}, "x");
  // 120,000 wARS at 18dp.
  assertStringIncludes(t, 'sell_total_liquidity_collateral = "120000000000000000000000"');
  assert(!/e\+/.test(t), "no scientific notation in atomic amounts");
});
