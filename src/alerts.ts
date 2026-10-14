/// Tell the team when something changes — and only when it changes.
///
/// Channels, either or both:
///   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   a bot message to a group
///   ALERT_WEBHOOK_URL                       a JSON POST {text, event, at}
/// With neither set, alerts go to stderr only, so nothing breaks in dev.
///
/// Events are de-duplicated per `key` in state/alerts.json, on the VALUE: a key
/// alerts only when its value changes. One key per thing being watched (not
/// per event type) — so a feed that goes dark, recovers and goes dark again
/// alerts three times, and a feed dark for an hour alerts once, not 360 times.
/// A failed send never throws into the caller — an alerting outage must not
/// stop the bot it is watching.

import { readJson, writeJson } from "./state.ts";

export type AlertEvent = "feed-down" | "feed-up" | "regime" | "halt" | "stitch" | "test";

export async function alert(event: AlertEvent, key: string, value: string, text: string): Promise<boolean> {
  const last = await readJson<Record<string, string>>("alerts.json", {});
  if (last[key] === value) return false;
  last[key] = value;
  await writeJson("alerts.json", last);

  const line = `[Cambio] ${text}`;
  console.error(line);
  const sends: Promise<unknown>[] = [];

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (token && chat) {
    sends.push(fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: line, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    }));
  }
  const hook = Deno.env.get("ALERT_WEBHOOK_URL");
  if (hook) {
    sends.push(fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: line, event, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    }));
  }
  const results = await Promise.allSettled(sends);
  for (const r of results) if (r.status === "rejected") console.error("alert send failed:", r.reason?.message ?? r.reason);
  return true;
}

/// `deno task alert-test` — the roadmap's "a test alert received".
if (import.meta.main) {
  const sent = await alert("test", "test", new Date().toISOString(), "test alert — if the team can read this, alerting works");
  console.log(sent ? "sent" : "deduplicated");
}
