import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inputHash, outputHash } from "@hirakumi/core";
import { createPurchase } from "@hirakumi/masumi";
import { need } from "../env.js";
import { runEscrowJob } from "../escrowBuyer.js";

const { values } = parseArgs({ options: { api: { type: "string" }, symbol: { type: "string", default: "ADA" } } });
if (!values.api) {
  console.error("Usage: pnpm --filter @hirakumi/buyer escrow -- --api <apiId> [--symbol ADA]");
  process.exit(1);
}
const masumi = { baseUrl: need("BUYER_PAYMENT_SERVICE_URL"), token: need("BUYER_PAYMENT_SERVICE_TOKEN"), network: "Preprod" as const };

const result = await runEscrowJob(
  {
    fetch,
    createPurchase: (p) => createPurchase(masumi, p),
    inputHash,
    outputHash,
    log: (l) => console.log(l),
    sleep: (ms) => sleep(ms),
    now: Date.now,
    newPurchaserId: () => randomBytes(10).toString("hex"),
  },
  {
    gatewayUrl: need("PUBLIC_BASE_URL"),
    apiId: values.api,
    input: { symbol: values.symbol },
    escrowUnit: need("MASUMI_ESCROW_UNIT"),
    maxEscrowMicros: BigInt(process.env.MAX_ESCROW_MICROS ?? "5000000"),
    pollMs: 5_000,
    timeoutMs: 30 * 60_000,
  },
);
process.exit(result.outcome === "completed" || result.outcome === "failed" ? 0 : 1);
