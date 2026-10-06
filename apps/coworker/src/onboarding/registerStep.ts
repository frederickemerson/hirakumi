import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import { apiLink, registryTokenLink, SOKOSUMI_LISTING_FORM, statusPageLink, tryPageLink } from "../links.js";
import type { Listing } from "../llm/ruleText.js";
import { enqueueMessage } from "../messages.js";
import { finishStep, getStep, runStep, saveStepOutput, touchStep, type StepRow } from "../steps.js";

import { MasumiInputError, type MasumiConfig } from "@hirakumi/masumi";

export type { MasumiConfig };
export type RegistryStatus = "Online" | "Offline" | "Deregistered" | "Invalid" | "Unknown";
export type MasumiPort = {
  registerAgent(
    c: MasumiConfig,
    a: { name: string; description: string; apiBaseUrl: string; priceMicros: bigint; unit: string; tags: string[]; exampleOutput?: string },
  ): Promise<{ registrationId: string }>;
  getAgentIdentifier(c: MasumiConfig, registrationId: string): Promise<string | null>;
  getRegistryStatus(c: MasumiConfig, agentIdentifier: string): Promise<RegistryStatus>;
};

export type RegisterDeps = {
  pool: pg.Pool;
  masumi: MasumiPort;
  masumiConfig: MasumiConfig;
  publicBaseUrl: string;
  webBaseUrl: string;
  escrowUnit: string;
  now?: () => Date;
};

export const REGISTRY_POLL_MS = 10_000;
export const REGISTRY_SLOW_MS = 20 * 60_000;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

async function registrationInput(deps: RegisterDeps, apiId: string) {
  const { rows } = await deps.pool.query<{ name: string; escrow_price_micros: string | null }>(
    `select a.name, (select p.escrow_price_micros from packs p where p.api_id = a.id order by p.id limit 1) as escrow_price_micros
     from apis a where a.id = $1`,
    [apiId],
  );
  const api = rows[0];
  if (!api?.escrow_price_micros) throw new PermanentError("No price is saved for this API yet. Set a price on the review page, then publish again.");
  const qa = await getStep(deps.pool, apiId, "qa");
  const listing = qa?.output?.listing as Listing | undefined;
  // The registry's own limits (packages/masumi validateListing): name and description 1-250 characters,
  // 1-15 tags of at most 63 characters, and exampleOutput must be an https URL (QA stores a JSON body, so it's omitted).
  const tags = (listing?.tags ?? []).map((t) => t.slice(0, 63)).filter(Boolean).slice(0, 15);
  return {
    name: api.name.slice(0, 250),
    description: clamp(listing?.description?.trim() || api.name, 250),
    apiBaseUrl: `${deps.publicBaseUrl}/a/${apiId}`,
    priceMicros: BigInt(api.escrow_price_micros),
    unit: deps.escrowUnit,
    tags: tags.length ? tags : ["api"],
  };
}

async function pollRegistration(deps: RegisterDeps, apiId: string, step: StepRow, registrationId: string, now: Date): Promise<void> {
  if (now.getTime() - step.updated_at.getTime() < REGISTRY_POLL_MS) return;
  await touchStep(deps.pool, apiId, "register");
  const output = step.output ?? {};
  let agentIdentifier = typeof output.agentIdentifier === "string" ? output.agentIdentifier : null;
  if (!agentIdentifier) {
    agentIdentifier = await deps.masumi.getAgentIdentifier(deps.masumiConfig, registrationId);
    if (agentIdentifier) {
      const id = agentIdentifier;
      await withTx(deps.pool, async (c) => {
        await c.query(`update apis set agent_identifier = $2 where id = $1 and state = 'registering'`, [apiId, id]);
        await saveStepOutput(c, apiId, "register", { agentIdentifier: id });
      });
    }
  }
  // Without a registry token the status can't be read; the minted agent NFT is then the signal (logged on purpose).
  const registryChecked = Boolean(deps.masumiConfig.registryToken);
  if (agentIdentifier && !registryChecked) console.info(`[register] ${apiId}: no REGISTRY_API_KEY, going Live on the minted NFT ${agentIdentifier}`);
  if (agentIdentifier && (!registryChecked || (await deps.masumi.getRegistryStatus(deps.masumiConfig, agentIdentifier)) === "Online")) {
    const id = agentIdentifier;
    await withTx(deps.pool, async (c) => {
      const moved = await c.query(`update apis set state = 'live' where id = $1 and state = 'registering'`, [apiId]);
      if (moved.rowCount !== 1) return;
      await finishStep(c, apiId, "register", { agentIdentifier: id });
      await enqueueMessage(c, {
        apiId,
        body: `Your API is Live on the Masumi agent market and shows Online. Agent ID: ${id}. Buyers call it at ${deps.publicBaseUrl}/a/${apiId}.\n` +
          `Public status page: ${statusPageLink(deps.webBaseUrl, apiId)}\n` +
          `Try it: ${tryPageLink(deps.webBaseUrl, apiId)}\n` +
          `Registry token: ${registryTokenLink(id)}\n` +
          `Your dashboard and buyer snippet: ${apiLink(deps.webBaseUrl, apiId)}. To also list it on Sokosumi, submit the prepared listing text at ${SOKOSUMI_LISTING_FORM}.`,
        taskStatus: "COMPLETED",
        dedupeKey: `live:${apiId}`,
        step: "Register on Masumi",
      });
    });
    return;
  }
  const registeredAt = typeof output.registeredAt === "string" ? Date.parse(output.registeredAt) : now.getTime();
  if (now.getTime() - registeredAt > REGISTRY_SLOW_MS) {
    await enqueueMessage(deps.pool, {
      apiId,
      body: "Registration is taking longer than usual (over 20 minutes). I'm still checking, and the Hirakumi team has been alerted.",
      dedupeKey: `registry_slow:${apiId}`,
    });
  }
}

/** registering → live. registerAgent runs at most once per API unless an operator resets the step. */
export async function registerStep(deps: RegisterDeps, apiId: string): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await enqueueMessage(deps.pool, {
    apiId,
    body: "Publishing your API to the Masumi registry. This usually takes about a minute.",
    taskStatus: "RUNNING",
    dedupeKey: `registering:${apiId}`,
    step: "Register on Masumi",
  });
  const step = await getStep(deps.pool, apiId, "register");
  const registrationId = step?.output?.registrationId;
  if (step && typeof registrationId === "string") return pollRegistration(deps, apiId, step, registrationId, now);
  await runStep(deps.pool, apiId, "register", async (previous) => {
    if (previous?.status === "running") {
      throw new PermanentError(
        "a registration attempt was interrupted, so we can't tell whether it reached Masumi. The Hirakumi team will check the payment service before retrying, so you are never charged twice.",
      );
    }
    const input = await registrationInput(deps, apiId);
    let id: string;
    try {
      ({ registrationId: id } = await deps.masumi.registerAgent(deps.masumiConfig, input));
    } catch (e) {
      if (e instanceof MasumiInputError) throw new PermanentError(`the Masumi registry would reject this listing: ${e.message}`);
      // A timeout or 5xx may arrive after the node accepted the mint. Retrying could mint a second NFT,
      // so an operator checks the payment service first (see the register runbook).
      throw new PermanentError(
        "the registration request didn't get a clear answer, so we can't tell whether it reached Masumi. The Hirakumi team will check the payment service before retrying, so you are never charged twice.",
      );
    }
    try {
      await saveStepOutput(deps.pool, apiId, "register", { registrationId: id, registeredAt: now.toISOString() }, "pending");
    } catch (e) {
      // The mint already happened. A normal (retryable) error here would run registerAgent again and mint a
      // second NFT, so stop and keep the registration id in the failure for the operator.
      throw new PermanentError(
        `the API was registered on Masumi (registration ${id}) but saving that failed: ${(e as Error).message}. ` +
          "The Hirakumi team will finish it from that registration id; nothing will be minted again.",
      );
    }
  }, now);
}
