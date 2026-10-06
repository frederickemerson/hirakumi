import { HTTPFacilitatorClient } from "@x402/core/server";
import { createDb, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { ChannelWatcher } from "./channelWatcher";
import { blockfrostEscrowChain } from "./escrowChain";
import { loadConfig } from "./config";
import { HealthTracker } from "./health";
import { JobRunner } from "./jobs";
import { masumiPortFrom } from "./masumi-live";
import { Monitor } from "./monitor";
import { BLOCKFROST_PREPROD, blockfrostLookup, Reconciler } from "./reconcile";
import { ApiRegistry } from "./registry";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`[gateway] migrations applied: ${applied.join(", ")}`);

const health = new HealthTracker(config.thresholds);
const registry = new ApiRegistry(sql, health);
const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const masumi = config.masumi ? masumiPortFrom(config.masumi) : null;
if (!masumi) console.warn("[gateway] PAYMENT_SERVICE_URL/TOKEN not set: start_job answers 503 escrow_unavailable");

const escrowChain = config.packEscrow && config.blockfrostProjectId
  ? blockfrostEscrowChain({ baseUrl: process.env.BLOCKFROST_BASE_URL?.trim() || BLOCKFROST_PREPROD, projectId: config.blockfrostProjectId }, config.packEscrow.operatorMnemonic)
  : null;
if (config.packEscrow && !escrowChain) console.warn("[gateway] PACK_MODE=escrow without BLOCKFROST_PROJECT_ID: escrow locks are never verified");
if (config.packEscrow && !config.packEscrow.operatorMnemonic) console.warn("[gateway] OPERATOR_MNEMONIC not set: the ChannelWatcher only observes (no Close / Raise / Settle)");
const app = createApp({ sql, config, registry, health, facilitator, masumi, escrowChain });
const monitor = new Monitor({ sql, registry, health, config });
monitor.start();
const jobs = masumi ? new JobRunner({ sql, registry, masumi, config }) : null;
jobs?.start();
const reconciler = config.blockfrostProjectId ? new Reconciler({ sql, lookup: blockfrostLookup(config.blockfrostProjectId) }) : null;
reconciler?.start();
const watcher = escrowChain && config.packEscrow ? new ChannelWatcher({ sql, chain: escrowChain, config: config.packEscrow, intervalMs: config.demoMode ? 10_000 : 30_000 }) : null;
watcher?.start();
if (!reconciler) console.warn("[gateway] BLOCKFROST_PROJECT_ID not set: pending tokens are activated only by the settle hook");

const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s escrow=${masumi ? "on" : "off"} reconcile=${reconciler ? "on" : "off"} packs=${config.packMode}${watcher ? ` watcher=${escrowChain?.operator ? "acting" : "observing"}` : ""}`);
});

const shutdown = async () => {
  monitor.stop();
  jobs?.stop();
  reconciler?.stop();
  watcher?.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
