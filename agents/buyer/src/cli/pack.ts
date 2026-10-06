import { parseArgs } from "node:util";
import { cliArgs } from "../cliArgs.js";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { need } from "../env.js";
import { createPackPayer } from "../payClient.js";
import { PendingStore, TokenStore } from "../tokenStore.js";
import { runPackDemo } from "../packBuyer.js";

const { values } = parseArgs({ args: cliArgs(),
  options: {
    api: { type: "string" },
    op: { type: "string", default: "getPrice" },
    symbol: { type: "string", default: "ADA" },
    calls: { type: "string", default: "20" },
    interval: { type: "string", default: "2000" },
    fresh: { type: "boolean", default: false },
  },
});
if (!values.api) {
  console.error("Usage: pnpm --filter @hirakumi/buyer pack -- --api <apiId> [--op getPrice] [--symbol ADA] [--calls 20] [--interval 2000] [--fresh]");
  process.exit(1);
}

const maxPackMicros = BigInt(process.env.MAX_PACK_MICROS ?? "5000000");
const payer = createPackPayer({
  mnemonic: need("BUYER_MNEMONIC"),
  blockfrostProjectId: need("BLOCKFROST_PROJECT_ID"),
  blockfrostBaseUrl: process.env.BLOCKFROST_BASE_URL ?? "https://cardano-preprod.blockfrost.io/api/v0",
  maxPackMicros,
});
const tokens = new TokenStore(resolve(import.meta.dirname, "../../.tokens.json"));
const pending = new PendingStore(resolve(import.meta.dirname, "../../.pending-payments.json"));
if (values.fresh) tokens.delete(values.api);

console.log(`Buyer wallet ${payer.address}  spend cap ${maxPackMicros} micros per payment`);
const summary = await runPackDemo(
  { fetch, buyPack: payer.buyPack, tokens, pending, log: (l) => console.log(l), sleep: (ms) => sleep(ms), now: Date.now },
  {
    gatewayUrl: need("PUBLIC_BASE_URL"),
    apiId: values.api,
    opId: values.op,
    query: { symbol: values.symbol },
    calls: Number(values.calls),
    intervalMs: Number(values.interval),
    maxPackMicros,
    pendingTimeoutMs: 90_000,
    pendingPollMs: 3_000,
  },
);
process.exit(summary.creditAccountingOk ? 0 : 2);
