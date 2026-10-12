/// ERC-8021 attribution suffix, Schema 0: the codes, comma-joined ASCII, then
/// one length byte, the schema id 0x00, and the 16-byte marker. It sits after
/// the calldata, where the EVM ignores it; Celo's indexer reads it to credit
/// the builder. Untagged transactions can never be credited later.
///
/// `ATTRIBUTION_CODE` is THIS project's code — the one Loops issued to Cambio's
/// own submitter. Never Remesso's: the two entries are judged separately.
///
/// Pinned in test/attribution.test.ts to the suffix Loops itself printed for a
/// real code — one wrong byte and the indexer silently sees nothing.

const MARKER = "80218021802180218021802180218021";

export function attributionSuffix(codes: string[]): `0x${string}` {
  const clean = codes.map((c) => c.trim()).filter((c) => /^[a-z0-9_]{1,32}$/.test(c));
  if (!clean.length) return "0x";
  const bytes = new TextEncoder().encode(clean.join(","));
  if (bytes.length > 255) throw new Error("attribution codes too long");
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}${bytes.length.toString(16).padStart(2, "0")}00${MARKER}`;
}

export const projectSuffix = () =>
  attributionSuffix((Deno.env.get("ATTRIBUTION_CODE") ?? "").split(","));
