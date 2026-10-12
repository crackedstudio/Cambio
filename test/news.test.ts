import { assertEquals } from "@std/assert";
import { postTexts } from "../src/news.ts";

Deno.test("post text is found wherever the provider nests it", () => {
  const body = { data: { timeline: [{ legacy: { full_text: "corrida cambiaria hoy" } }, { text: "cepo y devaluación" }], cursor: "abc" } };
  assertEquals(postTexts(body), ["corrida cambiaria hoy", "cepo y devaluación"]);
});
