import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { DEFAULT_REGISTRY_URL } from "../src/constants.js";
import { call } from "../src/http.js";
import { refreshRegistryStatus } from "../src/registry.js";
import { loadRootEnv } from "./env.js";
import { intervalSeconds } from "./lib.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    minutes: { type: "string", default: "30" },
    refresh: { type: "boolean", default: false },
  },
});
if (!values.agent) throw new Error("--agent <agentIdentifier> is required");
const agent = values.agent;
const c = masumiConfigFromEnv();
if (!c.registryToken) throw new Error("Set REGISTRY_API_KEY: this script reads the Masumi registry service");
const registryToken: string = c.registryToken;
const registryUrl = c.registryUrl ?? DEFAULT_REGISTRY_URL;

if (values.refresh) {
  const t0 = Date.now();
  const status = await refreshRegistryStatus(c, agent);
  console.log(`${new Date().toISOString()} refresh → ${status} in ${Date.now() - t0} ms`);
  process.exit(0);
}

const until = Date.now() + Number(values.minutes) * 60_000;
const checks: string[] = [];
let last = "";
while (Date.now() < until) {
  const { entries } = await call<{ entries: Array<{ status: string; lastUptimeCheck: string }> }>(
    registryUrl, registryToken, "POST", "/registry-entry/",
    { body: { network: c.network, filter: { assetIdentifier: agent }, limit: 1 } },
  );
  const entry = entries[0];
  const line = entry ? `${entry.status} lastUptimeCheck=${entry.lastUptimeCheck}` : "not indexed";
  if (line !== last) {
    console.log(`${new Date().toISOString()} ${line}`);
    last = line;
  }
  if (entry && !checks.includes(entry.lastUptimeCheck)) checks.push(entry.lastUptimeCheck);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
console.log(JSON.stringify({ agent, healthCheckIntervalSeconds: intervalSeconds(checks) }));
