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

// ---- patch mode: the file the Stitch panel owns ----
import { patchStitch, poolValues } from "../src/stitchconf.ts";

const panel = await Deno.readTextFile(new URL("./fixtures/panel-stitch.toml", import.meta.url));
const wars = (t: string) => t.split("[[pools]]")[1];

Deno.test("patch sets only Cambio's keys in the wARS pool", () => {
  const { text, report } = patchStitch(panel, { "wars-usdt": "elevated" }, "http://172.17.0.1:8787");
  const p = wars(text);
  assertStringIncludes(p, 'feed_url = "http://172.17.0.1:8787/feed/wars-usdt"');
  assertStringIncludes(p, "buy_offset_bps = 45");
  assertStringIncludes(p, "sell_offset_bps = 45");
  assertStringIncludes(p, 'buy_total_liquidity_debt = "37500000"');
  // Replaced in place, not duplicated.
  assertEquals(p.split("sell_offset_bps").length - 1, 1);
  assertEquals(report.patched, ["wars-usdt"]);
  assertEquals(report.missing, ["wbrl-usdt"]);
});

Deno.test("patch leaves every line it does not own exactly as the panel wrote it", () => {
  const { text } = patchStitch(panel, {}, "x");
  for (const kept of [
    'corridor_id = "cmb3k1x0000wars"', "buy_offset_abs = 2.0", "buy_max_orders = 40", "ttl_secs = 120",
    'url = "https://api.textilecredit.com/price?pair=wars-usdt"', "staleness_secs = 900",
    'maker_id = "mk_panel"', "[vault]", 'address = "0x2222222222222222222222222222222222222222"',
    "modules_enabled = false",
  ]) assertStringIncludes(text, kept);
  // Someone else's pool is untouched.
  assertStringIncludes(text.split("[[pools]]")[2], "buy_offset_bps = 77");
  assert(!text.split("[[pools]]")[2].includes("feed_url"));
  // Removing Cambio's lines gives back the original, line for line.
  const owned = /^(feed_url|buy_offset_bps|sell_offset_bps|buy_total_liquidity_debt|sell_total_liquidity_collateral) =|^# set by Cambio/;
  const strip = (t: string) => t.split("\n").filter((l) => !owned.test(l.trim()));
  assertEquals(strip(text), strip(panel));
});

Deno.test("patching twice is the same as patching once", () => {
  const once = patchStitch(panel, { "wars-usdt": "elevated" }, "x").text;
  assertEquals(patchStitch(once, { "wars-usdt": "elevated" }, "x").text, once);
  // And a regime change moves the numbers, not the shape.
  const back = patchStitch(once, { "wars-usdt": "calm" }, "x").text;
  assertEquals(back.split("\n").length, once.split("\n").length);
  assertStringIncludes(wars(back), "buy_offset_bps = 15");
});

Deno.test("patch and render agree on the numbers", () => {
  const v = poolValues("wars-usdt", "elevated", "x");
  const r = renderStitch({ "wars-usdt": "elevated" }, "x");
  for (const [k, val] of Object.entries(v)) assertStringIncludes(r, `${k} = ${val}`);
});

Deno.test("settings that fight Cambio are reported", () => {
  const bad = panel.replace("book_enabled = false", "book_enabled = true").replace("ttl_secs = 120", "ttl_secs = 120\nlean_enabled = true");
  const w = patchStitch(bad, {}, "x").report.warnings.join(" ");
  assertStringIncludes(w, "lean_enabled");
  assertStringIncludes(w, "book_enabled");
  const noRfq = patchStitch(panel.replace(/\[rfq\][\s\S]*?(?=\[vault\])/, ""), {}, "x").report.warnings.join(" ");
  assertStringIncludes(noRfq, "Connect");
});
