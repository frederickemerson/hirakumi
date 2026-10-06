import { parseArgs } from "node:util";
import { masumiConfigFromEnv } from "../src/config.js";
import { MASUMI_ESCROW_UNIT } from "../src/constants.js";
import { getAgentIdentifier, refreshRegistryStatus, registerAgent } from "../src/registry.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();
const { values } = parseArgs({
  options: {
    name: { type: "string" },
    description: { type: "string" },
    url: { type: "string" },
    price: { type: "string", default: "1000000" },
    tag: { type: "string", multiple: true, default: ["hirakumi"] },
    example: { type: "string" },
    registration: { type: "string" },
  },
});
const c = masumiConfigFromEnv();
const start = Date.now();
const elapsed = () => `+${Math.round((Date.now() - start) / 1000)}s`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let registrationId = values.registration;
if (!registrationId) {
  if (!values.name || !values.description || !values.url) {
    throw new Error("--name, --description and --url are required (or --registration <id> to resume)");
  }
  ({ registrationId } = await registerAgent(c, {
    name: values.name,
    description: values.description,
    apiBaseUrl: values.url,
    priceMicros: BigInt(values.price),
    unit: MASUMI_ESCROW_UNIT,
    tags: values.tag,
    exampleOutput: values.example,
  }));
  console.log(`${elapsed()} registrationId=${registrationId}`);
}

let agentIdentifier: string | null = null;
while (agentIdentifier === null) {
  if (Date.now() - start > 30 * 60_000) throw new Error("not minted after 30 min: check selling-wallet tADA and `docker compose logs payment-service`");
  agentIdentifier = await getAgentIdentifier(c, registrationId);
  console.log(`${elapsed()} minted=${agentIdentifier ?? "not yet"}`);
  if (agentIdentifier === null) await sleep(15_000);
}
console.log(`AGENT_IDENTIFIER=${agentIdentifier}`);
console.log(`https://preprod.cardanoscan.io/token/${agentIdentifier}`);

if (!c.registryToken) {
  console.log("REGISTRY_API_KEY not set: skipping the Online check");
  process.exit(0);
}
for (;;) {
  const status = await refreshRegistryStatus(c, agentIdentifier);
  console.log(`${elapsed()} registry=${status}`);
  if (status === "Online") break;
  if (status === "Invalid") {
    throw new Error("registry says Invalid: /availability returned another agentIdentifier, redirected, or the URL is not public");
  }
  if (Date.now() - start > 45 * 60_000) throw new Error("not Online after 45 min");
  await sleep(30_000);
}
