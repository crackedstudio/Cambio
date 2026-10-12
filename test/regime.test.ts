import { assertEquals } from "@std/assert";
import { next, regimeOf, score } from "../src/regime.ts";

Deno.test("accents and case do not hide a term", () => {
  assertEquals(score("wars-usdt", ["El BCRA anunció una DEVALUACIÓN"]).score, 1 + 5 + 4);
});

Deno.test("a reposted post counts once", () => {
  const p = "corrida cambiaria en marcha, el dólar se dispara";
  assertEquals(score("wars-usdt", [p, p, p]).score, score("wars-usdt", [p]).score);
});

Deno.test("calm, elevated, shock thresholds", () => {
  assertEquals(regimeOf(0), "calm");
  assertEquals(regimeOf(12), "elevated");
  assertEquals(regimeOf(30), "shock");
});

Deno.test("up is immediate; down waits a quiet hour since the last confirmation", () => {
  const t0 = 1_800_000_000;
  let s = next({ regime: "calm", since: t0, lastConfirmed: t0 }, "shock", t0);
  assertEquals(s.regime, "shock");
  s = next(s, "shock", t0 + 3 * 3600); // shock confirmed 3h later
  s = next(s, "calm", t0 + 3 * 3600 + 600); // 10 quiet minutes: stays
  assertEquals(s.regime, "shock");
  s = next(s, "calm", t0 + 4 * 3600 + 60); // an hour after the last confirmation
  assertEquals(s.regime, "calm");
});
