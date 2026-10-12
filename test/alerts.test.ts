import { assertEquals } from "@std/assert";
import { alert } from "../src/alerts.ts";

Deno.test("a feed alerts on every change of state, and only then", async () => {
  const dir = await Deno.makeTempDir();
  const cwd = Deno.cwd();
  Deno.chdir(dir);
  await Deno.mkdir("state");
  try {
    const seq = ["up", "up", "down:regime shock", "down:regime shock", "up", "down:sources disagree", "up"];
    const sent: boolean[] = [];
    for (const v of seq) sent.push(await alert(v === "up" ? "feed-up" : "feed-down", "feed:wars-usdt", v, v));
    assertEquals(sent, [true, false, true, false, true, true, true]);
  } finally {
    Deno.chdir(cwd);
  }
});
