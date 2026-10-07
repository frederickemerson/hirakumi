import { HTTPFacilitatorClient } from "@x402/core/server";
import { setSelfAddresses } from "@hirakumi/core";
import { createDb, deleteStaleDecisions, deleteStaleQuotes, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { listen } from "./server";
import { ChannelWatcher } from "./channelWatcher";
import { demoBuyerFromEnv } from "./demoBuy";
import { DomainRegistry } from "./domains";
import { tlsAskApp } from "./frontDoorAdmin";
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

// No upstream may resolve to Hirakumi's own edge: it would come back in through the front door.
setSelfAddresses(config.edgeIps);
const health = new HealthTracker(config.thresholds);
const domains = new DomainRegistry(sql);
const registry = new ApiRegistry(sql, health, config.upstreamAuthPrivateKey);
const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const masumi = config.masumi ? masumiPortFrom(config.masumi) : null;
if (!masumi) console.warn("[gateway] PAYMENT_SERVICE_URL/TOKEN not set: start_job answers 503 escrow_unavailable");

const escrowChain = config.packEscrow && config.blockfrostProjectId
  ? blockfrostEscrowChain({ baseUrl: process.env.BLOCKFROST_BASE_URL?.trim() || BLOCKFROST_PREPROD, projectId: config.blockfrostProjectId }, config.packEscrow.operatorMnemonic)
  : null;
if (config.packMode === "escrow" && !escrowChain) console.warn("[gateway] PACK_MODE=escrow without BLOCKFROST_PROJECT_ID: escrow locks are never verified");
if (config.packMode === "hybrid" && !escrowChain) console.warn("[gateway] PACK_MODE=hybrid without escrow settings or BLOCKFROST_PROJECT_ID: every pack settles direct (the 402 still says what the policy recommends)");
if (config.packEscrow && !config.packEscrow.operatorMnemonic) console.warn("[gateway] OPERATOR_MNEMONIC not set: the ChannelWatcher only observes (no Close / Raise / Settle)");
const demoBuyer = demoBuyerFromEnv(process.env);
if (!demoBuyer) console.warn("[gateway] BUYER_MNEMONIC or BLOCKFROST_PROJECT_ID not set: \"Buy a pack live\" answers 503");
const app = createApp({ sql, config, registry, health, facilitator, masumi, escrowChain, demoBuyer, domains });
const monitor = new Monitor({ sql, registry, health, config, domains });
monitor.start();
const jobs = masumi ? new JobRunner({ sql, registry, masumi, config }) : null;
jobs?.start();
const reconciler = config.blockfrostProjectId ? new Reconciler({ sql, lookup: blockfrostLookup(config.blockfrostProjectId) }) : null;
reconciler?.start();
const watcher = escrowChain && config.packEscrow ? new ChannelWatcher({ sql, chain: escrowChain, config: config.packEscrow, intervalMs: config.demoMode ? 10_000 : 30_000 }) : null;
watcher?.start();
// Unpaid 402s store a settlement decision (and, in escrow, a quote) per buyer key pair. The watcher prunes them;
// without one (no escrow settings or no Blockfrost) prune them here, or they grow without bound.
const pruner = watcher ? null : setInterval(() => {
  deleteStaleQuotes(sql).catch((e) => console.error("[gateway] quote cleanup:", (e as Error).message));
  deleteStaleDecisions(sql).catch((e) => console.error("[gateway] settlement decision cleanup:", (e as Error).message));
}, 3_600_000);
if (!reconciler) console.warn("[gateway] BLOCKFROST_PROJECT_ID not set: pending tokens are activated only by the settle hook");

const server = listen(app, config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s escrow=${masumi ? "on" : "off"} reconcile=${reconciler ? "on" : "off"} packs=${config.packMode}${watcher ? ` watcher=${escrowChain?.operator ? "acting" : "observing"}` : ""}`);
});

// Caddy's on-demand TLS asks here before getting a certificate for a front-door host. Only Caddy reaches this port.
const tlsAsk = listen(tlsAskApp(domains), config.tlsAskPort, () => {
  console.log(`[gateway] tls ask listening on :${config.tlsAskPort} edge=${config.edgeIps.join(",")}`);
});

const shutdown = async () => {
  monitor.stop();
  jobs?.stop();
  reconciler?.stop();
  watcher?.stop();
  if (pruner) clearInterval(pruner);
  server.close();
  tlsAsk.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
