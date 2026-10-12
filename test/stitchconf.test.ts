import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("[rfq], [signer] and [gas] written by Stitch survive a regeneration", () => {
  const before = renderStitch({}, "x") + `
[rfq]
enabled = true
url = "wss://api.textilecredit.com/v2/maker/stream"
maker_id = "mk_abc"
api_key_env = "STITCH_RFQ_API_KEY"
validation_contract = "0x00000000000000000000000000000000000000aa"

[signer]
provider = "local"

[gas]
native_reserve = 1.0
`;
  const after = renderStitch({ "wars-usdt": "elevated" }, "x", before);
  assertStringIncludes(after, 'maker_id = "mk_abc"');
  assertStringIncludes(after, "enabled = true");
  assertStringIncludes(after, 'provider = "local"');
  assertStringIncludes(after, "native_reserve = 1.0");
  assertStringIncludes(after, "buy_offset_bps = 45");
  // Carried once, not duplicated by a second regeneration.
  const again = renderStitch({}, "x", after);
  assertEquals(again.split("[rfq]").length - 1, 1);
});

Deno.test("without [rfq] the file says how to enrol", () => {
  assertStringIncludes(renderStitch({}, "x"), "stitch connect");
});
