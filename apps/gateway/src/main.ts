import { HTTPFacilitatorClient } from "@x402/core/server";
import { createDb, migrate } from "@hirakumi/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { HealthTracker } from "./health";
import { Monitor } from "./monitor";
import { ApiRegistry } from "./registry";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`[gateway] migrations applied: ${applied.join(", ")}`);

const health = new HealthTracker(config.thresholds);
const registry = new ApiRegistry(sql, health);
const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const app = createApp({ sql, config, registry, health, facilitator, masumi: null });
const monitor = new Monitor({ sql, registry, health, config });
monitor.start();

const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} public=${config.publicBaseUrl} demo=${config.demoMode} ` +
    `probe=${config.probeIntervalMs / 1000}s facilitator=${config.facilitatorUrl}`);
});

const shutdown = async () => {
  monitor.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
