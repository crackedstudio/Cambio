/// Register Cambio's maker wallet as an ERC-8004 agent on Celo (roadmap 4.2).
///
///   MAKER_PRIVATE_KEY=0x… deno run --allow-net --allow-env --env-file=.env scripts/register-8004.ts --dry-run
///   MAKER_PRIVATE_KEY=0x… deno run --allow-net --allow-env --env-file=.env scripts/register-8004.ts
///
/// From the MAKER wallet on purpose: the hackathon wants the identity held by
/// the wallet whose activity is being judged. Pass the key only for this run
/// (it otherwise lives with Stitch); `--dry-run` prints the registration and
/// sends nothing. The transaction carries this project's attribution tag.
///
/// The registration file is embedded as a data: URI, so what is registered
/// cannot be rewritten later by whoever controls a web host.

import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { projectSuffix } from "../src/attribution.ts";
import { RPC } from "../src/config.ts";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const abi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

const dry = Deno.args.includes("--dry-run");
const key = (Deno.env.get("MAKER_PRIVATE_KEY") ?? "").trim() as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set MAKER_PRIVATE_KEY for this run only");
const account = privateKeyToAccount(key);
const maker = (Deno.env.get("MAKER_ADDRESS") ?? "").toLowerCase();
if (maker && maker !== account.address.toLowerCase()) throw new Error(`key is ${account.address}, MAKER_ADDRESS is ${maker}`);

const site = (Deno.env.get("DASHBOARD_URL") ?? "").trim();
const registration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Cambio",
  description:
    "A news-aware market maker for LatAm stablecoins on Celo. Quotes USDT/wARS and USDT/wBRL on Textile FX, " +
    "and pays other agents over x402 (the buy gateway, in USA₮) to read the news — widening or pulling its quotes " +
    "before a peso shock.",
  image: "",
  services: [
    ...(site ? [{ name: "web", endpoint: site }] : []),
    { name: "repository", endpoint: "https://github.com/crackedstudio/Cambio" },
  ],
  x402Support: false,
  active: true,
  registrations: [],
  supportedTrust: ["reputation"],
};
const uri = `data:application/json;base64,${btoa(unescape(encodeURIComponent(JSON.stringify(registration))))}`;
const suffix = projectSuffix();

console.log("registrant:", account.address);
console.log("registration:", JSON.stringify(registration, null, 2));
console.log("attribution suffix:", suffix === "0x" ? "NONE — set ATTRIBUTION_CODE" : suffix);

const pub = createPublicClient({ chain: celo, transport: http(RPC) });
const held = await pub.readContract({ address: REGISTRY, abi, functionName: "balanceOf", args: [account.address] });
if (held > 0n) {
  console.log(`this wallet already holds ${held} ERC-8004 identity token(s); not registering again`);
  Deno.exit(0);
}
if (dry) Deno.exit(0);
if (suffix === "0x") throw new Error("refusing to send an untagged transaction: set ATTRIBUTION_CODE");

const wallet = createWalletClient({ account, chain: celo, transport: http(RPC), dataSuffix: suffix } as never);
// deno-lint-ignore no-explicit-any
const hash = await (wallet as any).writeContract({ address: REGISTRY, abi, functionName: "register", args: [uri] });
const rc = await pub.waitForTransactionReceipt({ hash });
const minted = parseEventLogs({ abi, logs: rc.logs, eventName: "Transfer" }).find((l) => l.args.to.toLowerCase() === account.address.toLowerCase());
console.log(`${rc.status}: https://celoscan.io/tx/${hash}`);
console.log(`agent id: ${minted?.args.tokenId ?? "see the receipt"} — https://8004scan.io`);
