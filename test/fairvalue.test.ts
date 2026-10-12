import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { fairValue, skew, toStitchPrice } from "../src/fairvalue.ts";

const now = 1_800_000_000;
const q = (source: string, rate: number, age = 0) => ({ source, rate, at: now - age });

Deno.test("Stitch gets USDT per wARS, never wARS per USDT", () => {
  // Stitch's docs: publishing the inverted number "makes the bot post wildly
  // mispriced orders". 1602 wARS per dollar must leave as ~0.000624.
  assertAlmostEquals(toStitchPrice(1602), 0.000624, 0.000001);
  assert(toStitchPrice(1602) < 1);
  assertThrows(() => toStitchPrice(0));
});

Deno.test("median of agreeing sources", () => {
  const fv = fairValue([q("pool", 1602), q("textile", 1603), q("cripto", 1606), q("ccl", 1605)], now);
  assert(fv.ok);
  assertEquals(fv.rate, 1604);
});

Deno.test("an outlier is dropped, not averaged in", () => {
  // The official rate (~1512) is 6% off the market wARS trades at.
  const fv = fairValue([q("pool", 1602), q("textile", 1603), q("ccl", 1605), q("official", 1512)], now);
  assert(fv.ok);
  assertEquals(fv.dropped.map((d) => d.source), ["official"]);
  assertEquals(fv.rate, 1603);
});

Deno.test("too few fresh sources: no price", () => {
  const fv = fairValue([q("pool", 1602), q("ptax", 1600, 3600)], now);
  assertEquals(fv.ok, false);
});

Deno.test("two sources that disagree: no price", () => {
  const fv = fairValue([q("pool", 1602), q("textile", 1640)], now);
  assertEquals(fv.ok, false);
});

Deno.test("skew leans toward unloading the heavy side", () => {
  // Too many pesos (share 0.9): offer more pesos per dollar.
  assert(skew(1600, 0.9) > 1600);
  // Too few: fewer.
  assert(skew(1600, 0.1) < 1600);
  assertEquals(skew(1600, 0.5), 1600);
  // Capped at 25 bps for a fully one-sided book.
  assertAlmostEquals(skew(1600, 1), 1600 * 1.0025, 1e-9);
});

Deno.test("a published rate keeps its own, longer freshness window", () => {
  const fv = fairValue([q("pool", 1604), { source: "cripto", rate: 1606, at: now - 2 * 3600, maxAgeSecs: 3 * 3600 }], now);
  assert(fv.ok);
  assertEquals(fv.used.length, 2);
  // The same age with the default (15 min) is dropped.
  assertEquals(fairValue([q("pool", 1604), q("cripto", 1606, 2 * 3600)], now).ok, false);
});

Deno.test("only Argentina's published rates get the longer window", async () => {
  const src = await Deno.readTextFile(new URL("../src/sources.ts", import.meta.url));
  const withWindow = [...src.matchAll(/maxAgeSecs:/g)].length;
  // dolarapi alone sets one; Brazil's sources use the 15-minute default.
  assertEquals(withWindow, 1);
});
