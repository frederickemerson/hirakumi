import { parseArgs } from "node:util";
import { cliArgs, queryArgs } from "../cliArgs.js";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { need } from "../env.js";
import { createPackPayer } from "../payClient.js";
import { PendingStore, TokenStore } from "../tokenStore.js";
import { runPackDemo } from "../packBuyer.js";
import { IouKeyStore } from "../escrowPack.js";
import { closeEscrowPack, runEscrowPack } from "../escrowPackFlow.js";

const { values } = parseArgs({ args: cliArgs(),
  options: {
    api: { type: "string" },
    op: { type: "string", default: "getPrice" },
    symbol: { type: "string", default: "ADA" },
    query: { type: "string", multiple: true },
    calls: { type: "string", default: "20" },
    interval: { type: "string", default: "2000" },
    fresh: { type: "boolean", default: false },
    escrow: { type: "boolean", default: false },
    close: { type: "boolean", default: false },
    pack: { type: "string" },
    wait: { type: "boolean", default: false },
  },
});
if (!values.api) {
  console.error("Usage: pnpm --filter @hirakumi/buyer run pack -- --api <apiId> [--op getPrice] [--symbol ADA | --query name=value ...] [--calls 20] [--interval 2000] [--fresh] [--escrow] [--escrow --close --pack <packId> [--wait]]");
  process.exit(1);
}
const query = queryArgs(values.query, values.symbol);

const maxPackMicros = BigInt(process.env.MAX_PACK_MICROS ?? "5000000");
// A hybrid gateway may settle a pack direct (paid to the seller, no refund): we accept that only up to this.
const maxDirectMicros = BigInt(process.env.MAX_DIRECT_MICROS ?? "5000000");
// REQUIRE_ESCROW=1: always ask for escrow (unused credits come back) and refuse any direct offer.
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

if (values.escrow) {
  // IOU secret keys: owner-only file, git-ignored (agents/buyer/.escrow-keys.json*).
  const store = new IouKeyStore(resolve(import.meta.dirname, "../../.escrow-keys.json"));
  const gatewayUrl = need("PUBLIC_BASE_URL");
  if (values.close) {
    await closeEscrowPack(
      { fetch, store, log: (l) => console.log(l), sleep: (ms) => sleep(ms) },
      { gatewayUrl, apiId: values.api, packIds: values.pack ? [values.pack] : [], wait: values.wait, pollMs: 15_000, timeoutMs: 30 * 60_000 },
    );
    process.exit(0);
  }
  const summary = await runEscrowPack(
    { fetch, buyEscrowPack: payer.buyEscrowPack, store, refundAddress: payer.address, log: (l) => console.log(l), sleep: (ms) => sleep(ms), now: () => new Date() },
    { gatewayUrl, apiId: values.api, opId: values.op, query, calls: Number(values.calls), intervalMs: Number(values.interval),
      maxPackMicros, maxDirectMicros, requireEscrow: process.env.REQUIRE_ESCROW === "1", pendingTimeoutMs: 180_000, pendingPollMs: 5_000 },
  );
  process.exit(summary.disputed ? 2 : 0);
}
const summary = await runPackDemo(
  { fetch, buyPack: payer.buyPack, tokens, pending, log: (l) => console.log(l), sleep: (ms) => sleep(ms), now: Date.now },
  {
    gatewayUrl: need("PUBLIC_BASE_URL"),
    apiId: values.api,
    opId: values.op,
    query,
    calls: Number(values.calls),
    intervalMs: Number(values.interval),
    maxPackMicros,
    pendingTimeoutMs: 90_000,
    pendingPollMs: 3_000,
  },
);
process.exit(summary.creditAccountingOk ? 0 : 2);
