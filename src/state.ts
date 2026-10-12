/// The few facts the three processes share, as JSON files under `state/`.
/// Files rather than a database: one machine, three small processes, and an
/// operator who can `cat` exactly what the bot believes.
///
/// Writes are atomic (temp file + rename) so the feed never reads half a
/// regime the news agent is still writing.

import type { CorridorId } from "./config.ts";
import type { RegimeState } from "./regime.ts";

const DIR = "state";

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(`${DIR}/${name}`)) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(name: string, value: unknown) {
  const tmp = `${DIR}/.${name}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2));
  await Deno.rename(tmp, `${DIR}/${name}`);
}

/// Written by `news.ts`, read by `feed.ts` and `stitchconf.ts`.
export type Regimes = Partial<Record<CorridorId, RegimeState>>;
export const readRegimes = () => readJson<Regimes>("regime.json", {});

/// Written by `ledger.ts`, read by `feed.ts`: when the day's realised loss
/// passes the limit, the feed stops publishing for the rest of the UTC day.
export type Halt = { haltedUntil: number | null; reason: string | null };
export const readHalt = () => readJson<Halt>("halt.json", { haltedUntil: null, reason: null });

/// One line per paid x402 call the news agent makes — the evidence that it
/// paid for what it used, and what each payment changed.
export async function appendSpend(entry: Record<string, unknown>) {
  await Deno.writeTextFile(`${DIR}/spend.jsonl`, JSON.stringify(entry) + "\n", { append: true });
}

export async function readSpend(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await Deno.readTextFile(`${DIR}/spend.jsonl`)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
