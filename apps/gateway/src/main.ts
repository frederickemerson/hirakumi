import { HTTPFacilitatorClient } from "@x402/core/server";
import { createDb, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { HealthTracker } from "./health";
import { JobRunner } from "./jobs";
import { masumiPortFrom } from "./masumi-live";
import { Monitor } from "./monitor";
import { blockfrostLookup, Reconciler } from "./reconcile";
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

const app = createApp({ sql, config, registry, health, facilitator, masumi });
const monitor = new Monitor({ sql, registry, health, config });
monitor.start();
const jobs = masumi ? new JobRunner({ sql, registry, masumi, config }) : null;
jobs?.start();
const reconciler = config.blockfrostProjectId ? new Reconciler({ sql, lookup: blockfrostLookup(config.blockfrostProjectId) }) : null;
reconciler?.start();
if (!reconciler) console.warn("[gateway] BLOCKFROST_PROJECT_ID not set: pending tokens are activated only by the settle hook");

const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s escrow=${masumi ? "on" : "off"} reconcile=${reconciler ? "on" : "off"}`);
});

const shutdown = async () => {
  monitor.stop();
  jobs?.stop();
  reconciler?.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
