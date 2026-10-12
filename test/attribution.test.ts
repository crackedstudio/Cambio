import { assertEquals } from "@std/assert";
import { attributionSuffix } from "../src/attribution.ts";

Deno.test("matches the dataSuffix Loops printed for a real code", () => {
  // `loops project get` for celo_5cd35ca55baf, 2026-10-06.
  assertEquals(
    attributionSuffix(["celo_5cd35ca55baf"]),
    "0x63656c6f5f356364333563613535626166110080218021802180218021802180218021",
  );
});

Deno.test("invalid codes are dropped; none means no suffix", () => {
  assertEquals(attributionSuffix(["", "Not Valid!"]), "0x");
});
