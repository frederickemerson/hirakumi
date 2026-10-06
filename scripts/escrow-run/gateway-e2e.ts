// End-to-end on preprod through the real gateway code: an in-process gateway (PACK_MODE=escrow, hosted x402
// facilitator, Blockfrost, the operator wallet as closer) on a throwaway Postgres schema, a stub price API,
// and the ChannelWatcher. Drive it with the buyer agent:
//
//   pnpm --filter @hirakumi/buyer pack -- --api <apiId> --escrow --calls 3
//   pnpm --filter @hirakumi/buyer pack -- --api <apiId> --escrow --close --wait
//
// Env: ENV_FILE / ESCROW_RUN_SECRETS as for run.ts; E2E_PORT (default 4599); E2E_FEE_BPS (default 300).
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createTestDb } from "@hirakumi/db/testing";
import { createApp } from "../../apps/gateway/src/app";
import { ChannelWatcher } from "../../apps/gateway/src/channelWatcher";
import { blockfrostEscrowChain } from "../../apps/gateway/src/escrowChain";
import { HealthTracker } from "../../apps/gateway/src/health";
import { ApiRegistry } from "../../apps/gateway/src/registry";
import type { GatewayConfig } from "../../apps/gateway/src/config";
import { seedLiveApi, startStubUpstream, testConfig } from "../../apps/gateway/test/helpers";
import { loadEnv, need, walletFor } from "./lib.js";

loadEnv();
process.env.ALLOW_INSECURE_UPSTREAM = "1";
const port = Number(process.env.E2E_PORT ?? 4599);
const operatorMnemonic = need("OPERATOR_MNEMONIC");
const feeAddress = process.env.E2E_FEE_ADDRESS ?? walletFor(need("FEE_MNEMONIC")).address;

const db = await createTestDb();
const stub = await startStubUpstream();
const seeded = await seedLiveApi(db.sql, stub.origin);
await db.sql`update sellers set cardano_addr = ${need("SELLER_ADDRESS")} where id = ${seeded.sellerId}`;

const config: GatewayConfig = {
  ...testConfig(),
  port,
  publicBaseUrl: `http://127.0.0.1:${port}`,
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://x402.preprod.dev.ecosyseng.cf-deployments.org",
  upstreamTimeoutMs: 15_000,
  blockfrostProjectId: need("BLOCKFROST_PROJECT_ID"),
  packMode: "escrow",
  packEscrow: {
    feeAddress, feeBps: Number(process.env.E2E_FEE_BPS ?? 300), closerVkh: walletFor(operatorMnemonic).vkh, operatorMnemonic,
    contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000, leaseSeconds: 30, raiseMarginMs: 60_000,
  },
};
const health = new HealthTracker(config.thresholds);
const registry = new ApiRegistry(db.sql, health);
const escrowChain = blockfrostEscrowChain({ baseUrl: need("BLOCKFROST_BASE_URL"), projectId: config.blockfrostProjectId! }, operatorMnemonic);
const app = createApp({ sql: db.sql, config, registry, health, facilitator: new HTTPFacilitatorClient({ url: config.facilitatorUrl }), masumi: null, escrowChain });
const watcher = new ChannelWatcher({ sql: db.sql, chain: escrowChain, config: config.packEscrow!, intervalMs: 15_000 });
const tick = async () => {
  try {
    for (const e of await watcher.tick()) console.log(`[e2e] watcher ${e.action} ${e.channelId}${e.tx ? ` tx ${e.tx}` : ""}`);
  } catch (e) {
    console.error("[e2e] watcher", (e as Error).message);
  }
};
setInterval(() => { void tick(); }, 15_000);

app.listen(port, "127.0.0.1", () => {
  console.log(`[e2e] gateway http://127.0.0.1:${port}  api ${seeded.apiId}  pack ${seeded.packId}  schema ${db.schema}`);
  console.log(`[e2e] closer ${config.packEscrow!.closerVkh}  fee ${feeAddress} @ ${config.packEscrow!.feeBps} bps`);
});
