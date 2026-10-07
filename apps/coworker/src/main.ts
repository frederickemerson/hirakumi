import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as masumi from "@hirakumi/masumi";
import { processHealthEvents } from "./alerts.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createGatewayClient } from "./gateway.js";
import { createStructuredCall } from "./llm/claude.js";
import { createOpenAiStructuredCall } from "./llm/openai.js";
import { startLoop } from "./loop.js";
import { selectMode } from "./mode.js";
import { describeStep } from "./onboarding/describeStep.js";
import { driveOnce, type StateHandlers } from "./onboarding/driver.js";
import { parseStep } from "./onboarding/parseStep.js";
import { qaStep } from "./onboarding/qaStep.js";
import { registerStep, type MasumiPort } from "./onboarding/registerStep.js";
import { createSpecFetcher } from "./openapi/fetchSpec.js";
import { createSokosumiClient, type SokosumiCoworker } from "./sokosumi/client.js";
import { createInbox } from "./sokosumi/inbox.js";
import { deliverMessages } from "./sokosumi/outbox.js";
import { reportOnboardingUsage } from "./sokosumi/usage.js";

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const llm = config.llm.provider === "openai"
  ? createOpenAiStructuredCall(new OpenAI({ apiKey: config.llm.apiKey }))
  : createStructuredCall(new Anthropic({ apiKey: config.llm.apiKey }));
const gateway = createGatewayClient(config.gatewayInternalUrl, config.internalToken);
const masumiPort: MasumiPort = masumi;
const fetchSpec = createSpecFetcher();

const handlers: StateHandlers = {
  intake: (apiId) => parseStep({
    pool, fetchSpec, allowInsecure: process.env.ALLOW_INSECURE_UPSTREAM === "1", multiPartKeys: process.env.UPSTREAM_AUTH_V3 === "1",
  }, apiId),
  parsed: (apiId) => describeStep({ pool, llm, webBaseUrl: config.webBaseUrl }, apiId),
  ownership_verified: (apiId) => qaStep({ pool, gateway, llm, webBaseUrl: config.webBaseUrl }, apiId),
  registering: (apiId) =>
    registerStep(
      { pool, masumi: masumiPort, masumiConfig: config.masumi, publicBaseUrl: config.publicBaseUrl, webBaseUrl: config.webBaseUrl, escrowUnit: config.escrowUnit },
      apiId,
    ),
};

const inFlight = new Set<string>();
startLoop("onboarding", 2_000, () => driveOnce(pool, handlers, inFlight));
startLoop("health-alerts", 5_000, () => processHealthEvents(pool, config.webBaseUrl));

const soko = config.sokosumi ? createSokosumiClient(config.sokosumi) : null;
let me: SokosumiCoworker | null = null;
if (soko) {
  try {
    me = await soko.me();
  } catch (e) {
    console.error(`[sokosumi] GET /v1/coworkers/me failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const mode = selectMode(me);
if (soko && mode.kind === "sokosumi") {
  // Replies on a task: typed commands first; the LLM only maps free text to the choice the coworker offered.
  const inbox = createInbox({
    pool, soko, webBaseUrl: config.webBaseUrl, fetchSpec, llm, allowInsecure: process.env.ALLOW_INSECURE_UPSTREAM === "1",
    multiPartKeys: process.env.UPSTREAM_AUTH_V3 === "1",
  });
  startLoop("sokosumi-inbox", 5_000, () => inbox.poll());
  startLoop("sokosumi-outbox", 2_000, () => deliverMessages(pool, soko, config.webBaseUrl));
  startLoop("sokosumi-usage", 30_000, () => reportOnboardingUsage(pool, soko, config.onboardingCredits));
  console.info(`[coworker] Sokosumi mode as ${me?.name} (${me?.id})`);
} else {
  console.info(`[coworker] dashboard-chat mode: ${mode.kind === "dashboard" ? mode.reason : ""}. Messages stay in the messages table for the web app.`);
}
