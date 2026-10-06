import { normalizeSamplesBase, parseSampleLines, SampleError, SAMPLES_PROOF_FILE, specFromSamples } from "@hirakumi/core";
import type pg from "pg";
import type { Db } from "../db.js";
import { PermanentError } from "../errors.js";
import { apiLink, overviewLink, ownershipLink, reviewLink, setupLink } from "../links.js";
import type { StructuredCall } from "../llm/claude.js";
import { mapReplyToChoice, type Offered } from "../llm/replyChoice.js";
import { enqueueMessage, type TaskStatus } from "../messages.js";
import type { HumanStep } from "../humanSteps.js";
import { describeAuthHint, parseOpenApi, type AuthHint } from "../openapi/parse.js";
import {
  findLinks, findSamplesIntake, formatCommand, formatTusdm, isOnlySamples, LinkError, looksLikeSecret, parseCommand, SUGGESTED_PACK, validateOpenApiUrl,
  type Command, type SamplesIntake,
} from "./replies.js";
import {
  apiAuthHint, apiForTask, confirmSell, createTaskApi, linkedSeller, listOps, opLine, savePrice, type ListedOp, type TaskApi,
} from "./sellerActions.js";

/**
 * The seller's side of a Sokosumi task. A link in the brief or a reply starts onboarding; typed replies the coworker
 * asked for (`sell …`, `price …`) do the non-wallet steps; the wallet steps (sign in, prove ownership, approve
 * publishing) get one deep link each. Every reply gets exactly one answer (dedupe key per event).
 */
export type ConversationDeps = {
  pool: pg.Pool;
  webBaseUrl: string;
  fetchSpec: (url: string) => Promise<string>;
  /** Maps a free-text reply to an offered choice. null = typed replies only. */
  llm: StructuredCall | null;
  allowInsecure: boolean;
};
export type TaskRef = { taskId: string; sokosumiUserId: string; setupToken: string };

const SUGGESTED_PRICE = `${formatTusdm(SUGGESTED_PACK.priceMicros)} tUSDM for ${SUGGESTED_PACK.calls} calls, and ${formatTusdm(SUGGESTED_PACK.escrowPriceMicros)} tUSDM per escrow job`;

/**
 * How ownership is proven: the seller adds the API's own code (an `x-hirakumi-verify` line, shown on the
 * ownership page) at the root of the OpenAPI file they gave us, then signs once with their wallet.
 * There is no file to download or host.
 */
export const OWNERSHIP_HOW =
  "add the x-hirakumi-verify line from this page at the root of your OpenAPI file, then sign once with your Cardano wallet (no payment):";
/** Without an OpenAPI file: a small proof file in the API's base folder (@hirakumi/core SAMPLES_PROOF_FILE). */
export const OWNERSHIP_HOW_SAMPLES =
  `serve a file named ${SAMPLES_PROOF_FILE} in your API's base folder with the code from this page (the page shows its exact address), then sign once with your Cardano wallet (no payment):`;

export const ownershipHow = (api: Pick<TaskApi, "intakeKind">) => (api.intakeKind === "samples" ? OWNERSHIP_HOW_SAMPLES : OWNERSHIP_HOW);

/** Keys are added on the ownership page (sealed so only the gateway reads them), never in a comment. */
const keyLine = (hint: AuthHint | null) =>
  hint ? ` Your API needs a key (${describeAuthHint(hint)}): add it on the same page. Never paste it in a comment.` : "";

const NO_OPENAPI_HINT = "No OpenAPI file? Reply with your API's base URL and a few example requests, one per line, like GET /price?symbol=ADA";

/** Neither stored nor repeated: the comment is only answered. */
const SECRET_WARNING =
  "Your message looks like it has a key, token or password in it, so I didn't use or save it. Please delete that comment, and change the key if others can see this task. " +
  "Never paste keys here.";

/**
 * Where the key form is for the API's state (apps/web): the ownership page while proving ownership, the review page
 * after failed test calls and before publishing, the API's page once registering or live. Other pages redirect away.
 */
function keyFormLine(api: TaskApi | null, web: string): string {
  const sealed = "where only the Hirakumi gateway can read it";
  if (!api) return "You'll add your API's key on its ownership page. You'll get that page's link after you choose endpoints.";
  switch (api.state) {
    case "endpoints_confirmed":
      return `Add your API's key on its ownership page, ${sealed}: ${ownershipLink(web, api.id)}`;
    case "ownership_verified":
      return api.failed
        ? `Add your API's key on its review page, ${sealed}. The test calls then run again: ${reviewLink(web, api.id)}`
        : `If the test calls need the key, you can add it on the review page, ${sealed}: ${reviewLink(web, api.id)}`;
    case "rule_built":
    case "priced":
      return `Add your API's key on its review page, ${sealed}: ${reviewLink(web, api.id)}`;
    case "registering":
    case "live":
      return `Add your API's key on its page, ${sealed}: ${overviewLink(web, api.id)}`;
    default:
      return api.failed
        ? "You'll add your API's key on the ownership page after you start over and choose endpoints."
        : `You'll be able to add your API's key at the ownership step, after you choose endpoints: ${ownershipLink(web, api.id)}`;
  }
}

async function say(db: Db, task: TaskRef, key: string, body: string, o: { step?: HumanStep; status?: TaskStatus; apiId?: string | null } = {}) {
  await enqueueMessage(db, { apiId: o.apiId ?? null, taskId: task.taskId, body, taskStatus: o.status ?? null, dedupeKey: key, ...(o.step ? { step: o.step } : {}) });
}

/** The text a brand-new task arrived with (name, description, early comments). */
export async function handleBrief(deps: ConversationDeps, task: TaskRef, brief: string): Promise<void> {
  if (looksLikeSecret(brief)) {
    await say(deps.pool, task, `brief:${task.taskId}`,
      `${SECRET_WARNING} ${keyFormLine(null, deps.webBaseUrl)} Now reply with your OpenAPI link, or your base URL and example requests, without the key.`,
      { status: "INPUT_REQUIRED" });
    return;
  }
  const samples = findSamplesIntake(brief);
  if (samples) return handleSamples(deps, task, samples, `brief:${task.taskId}`);
  const links = findLinks(brief);
  if (links.length === 0) {
    await say(
      deps.pool, task, `setup:${task.taskId}`,
      `Hi! I'll put your API on the agent market. Reply here with the https link to your OpenAPI file, or open this setup link and paste it there (about 3 minutes, 4 clicks): ${setupLink(deps.webBaseUrl, task.setupToken)} ${NO_OPENAPI_HINT}.`,
      { status: "INPUT_REQUIRED" },
    );
    return;
  }
  await handleLink(deps, task, links[0], `brief:${task.taskId}`);
}

/** One seller comment on a known task. */
export async function handleReply(deps: ConversationDeps, task: TaskRef, eventId: string, text: string): Promise<void> {
  const key = `reply:${eventId}`;
  const api = await apiForTask(deps.pool, task.taskId);
  if (looksLikeSecret(text)) {
    await say(deps.pool, task, key, `${SECRET_WARNING} ${keyFormLine(api, deps.webBaseUrl)}`, { apiId: api?.id ?? null });
    return;
  }
  // Once an API is under way, a command wins ("price 2" with a note and a docs link under it). Example requests
  // start over only when there is no API yet, it failed, or the reply is nothing but links and example lines.
  const underWay = api !== null && !api.failed;
  if (!(underWay && parseCommand(text))) {
    const samples = findSamplesIntake(text);
    if (samples && (!underWay || isOnlySamples(text))) return handleSamples(deps, task, samples, key);
    const links = findLinks(text);
    if (links.length) return handleLink(deps, task, links[0], key);
  }

  const ops = api ? await listOps(deps.pool, api.id) : [];
  let cmd: Command | null = parseCommand(text);
  let understood = "";
  if (!cmd && deps.llm && api && !api.failed) {
    const offered = offeredFor(api, ops);
    if (offered) {
      cmd = await mapReplyToChoice(deps.llm, text, offered);
      if (cmd) understood = `I read your reply as \`${formatCommand(cmd)}\`. `;
    }
  }

  if (!api) {
    await say(deps.pool, task, key,
      `There's no API on this task yet. Reply with the https link to your OpenAPI file. If you already sent it, sign in with your wallet and paste it on the setup page: ${setupLink(deps.webBaseUrl, task.setupToken)} ${NO_OPENAPI_HINT}.`,
      { status: "INPUT_REQUIRED" });
    return;
  }
  if (api.failed && api.failedStep === "qa" && api.state === "ownership_verified") {
    // Ownership is proven, so starting over would lose it. A refused test call (401/403) is fixed with the key form,
    // and saving the key there runs the test calls again.
    await say(deps.pool, task, key,
      `The test calls stopped at the step I described above. If your API needs a key, add it on the review page and the test calls run again: ${reviewLink(deps.webBaseUrl, api.id)} Never paste the key in a comment. ` +
        `For any other problem, fix your API, then reply with your ${api.intakeKind === "samples" ? "base URL and example requests" : "OpenAPI link"} again to start over.`,
      { apiId: api.id, step: "Test calls", status: "INPUT_REQUIRED" });
    return;
  }
  if (api.failed) {
    await say(deps.pool, task, key, `Onboarding stopped at the step I described above. Fix it, then reply with your ${api.intakeKind === "samples" ? "base URL and example requests" : "OpenAPI link"} again to start over.`, { apiId: api.id, status: "INPUT_REQUIRED" });
    return;
  }
  if (cmd?.kind === "publish") {
    await say(deps.pool, task, key,
      `Publishing needs your wallet signature, so I can't do it from a comment. Approve it here (one signature): ${reviewLink(deps.webBaseUrl, api.id)}`,
      { apiId: api.id, step: "Register on Masumi" });
    return;
  }
  if (cmd?.kind === "sell") {
    const r = await confirmSell(deps.pool, api.id, cmd.refs, cmd.readOnlyConfirmed);
    if (!r.ok) {
      await say(deps.pool, task, key, `${understood}${r.error}`, { apiId: api.id, step: "Choose endpoints", status: "INPUT_REQUIRED" });
      return;
    }
    await say(deps.pool, task, key, `${understood}${r.message}`, { apiId: api.id, step: "Choose endpoints", status: "RUNNING" });
    await say(deps.pool, task, `${key}:ownership`,
      `Prove you own ${api.origin}: ${ownershipHow(api)} ${ownershipLink(deps.webBaseUrl, api.id)}${keyLine(await apiAuthHint(deps.pool, api.id))}`,
      { apiId: api.id, step: "Prove ownership", status: "INPUT_REQUIRED" });
    return;
  }
  if (cmd?.kind === "price") {
    const r = await savePrice(deps.pool, api.id, cmd.priceText, cmd.calls);
    await say(deps.pool, task, key,
      r.ok
        ? `${understood}${r.message} Publishing needs your wallet signature: approve it here (one signature): ${reviewLink(deps.webBaseUrl, api.id)}`
        : `${understood}${r.error}`,
      { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
    return;
  }
  const hint = api.state === "endpoints_confirmed" ? await apiAuthHint(deps.pool, api.id) : null;
  await say(deps.pool, task, key, helpFor(api, deps.webBaseUrl, hint), { apiId: api.id });
}

/** What a reply may choose at this point (for the LLM mapping), or null when the coworker asked for nothing. */
function offeredFor(api: TaskApi, ops: ListedOp[]): Offered | null {
  if (api.state === "described" || api.state === "endpoints_confirmed") {
    return { kind: "sell", endpoints: ops.map((o) => ({ ref: o.ref, opId: o.opId, method: o.method, path: o.path })) };
  }
  if (api.state === "rule_built" || api.state === "priced") return { kind: "price" };
  return null;
}

function helpFor(api: TaskApi, web: string, hint: AuthHint | null): string {
  switch (api.state) {
    case "intake":
    case "parsed":
      return `I'm still reading your ${api.intakeKind === "samples" ? "example requests" : "OpenAPI file"}. I'll post here as soon as it's done.`;
    case "described":
      return "Choose the endpoints to sell: reply `sell 1` with the numbers from my list (for example `sell 1 2`).";
    case "endpoints_confirmed":
      return `Next, prove you own the API: ${ownershipHow(api)} ${ownershipLink(web, api.id)}${keyLine(hint)} (To change the endpoints first, reply \`sell\` with new numbers.)`;
    case "ownership_verified":
      return "Test calls are running. I'll post the promise and a suggested price here when they're done.";
    case "rule_built":
    case "priced":
      return `Reply \`price 2\` to set the pack price in tUSDM (or \`price 3.5 for 200 calls\`). Publishing needs your wallet: ${reviewLink(web, api.id)}`;
    case "registering":
      return "Your API is being registered on Masumi. I'll post here when it's Live.";
    case "live":
      return `Your API is Live. Dashboard: ${apiLink(web, api.id)}`;
    default:
      return `Details: ${apiLink(web, api.id)}`;
  }
}

/** The step 2 prompt on a Sokosumi task: the numbered endpoint list and how to choose by reply. */
export function chooseEndpointsPrompt(ops: ListedOp[], sellable: number, web: string, apiId: string): string {
  return [
    `Found ${ops.length} endpoints; ${sellable} look sellable (read-only):`,
    ...ops.map(opLine),
    "Next, choose the endpoints to sell: reply `sell 1` with their numbers (for example `sell 1 2`). " +
      "Endpoints marked [may change data] also need `readonly` at the end, to confirm they change nothing on your server. " +
      `You can also choose on the web: ${apiLink(web, apiId)}`,
  ].join("\n");
}

/** What the seller sent to start onboarding: an OpenAPI link, or (any API) a base URL and example requests. */
type Intake = {
  name: string;
  origin: string;
  /** The OpenAPI file, or for samples the ownership proof file in the base folder. */
  openapiUrl: string;
  samples?: { base: string; lines: string };
  /** "your example requests for https://…" or the link: what "Reading … now" and "I couldn't read …" name. */
  label: string;
  specText: () => Promise<string>;
  /** What to paste on the setup page, and how to retry after an error. */
  setupHint: string;
  retryHint: string;
};

/** An OpenAPI link from the brief or a reply: start onboarding (linked seller) or read it and ask for the sign-in. */
async function handleLink(deps: ConversationDeps, task: TaskRef, raw: string, key: string): Promise<void> {
  let link: { url: string; origin: string; hostname: string };
  try {
    link = validateOpenApiUrl(raw, deps.allowInsecure);
  } catch (e) {
    if (!(e instanceof LinkError)) throw e;
    await say(deps.pool, task, key, `${e.message} Reply with the public https link to your OpenAPI file.`, { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  await startIntake(deps, task, key, {
    name: link.hostname,
    origin: link.origin,
    openapiUrl: link.url,
    label: link.url,
    // First time: read the file now (SSRF-safe fetch).
    specText: () => deps.fetchSpec(link.url),
    setupHint: "paste the same link on this setup page",
    retryHint: `Reply with the corrected link to try again. ${NO_OPENAPI_HINT}.`,
  });
}

/**
 * A base URL and example requests (no OpenAPI file): checked here with the same rules as the setup page. Nothing
 * is fetched: the endpoints come from the lines themselves.
 */
async function handleSamples(deps: ConversationDeps, task: TaskRef, intake: SamplesIntake, key: string): Promise<void> {
  if ("choices" in intake) {
    await say(deps.pool, task, key,
      `I found more than one link: ${intake.choices.join(" and ")}. Which one is your API's base URL? ` +
        "Reply with just that link, then your example requests, one per line.",
      { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  let base: ReturnType<typeof normalizeSamplesBase>;
  let samples: ReturnType<typeof parseSampleLines>;
  try {
    base = normalizeSamplesBase(intake.base, deps.allowInsecure);
    samples = parseSampleLines(intake.lines);
  } catch (e) {
    if (!(e instanceof SampleError)) throw e;
    await say(deps.pool, task, key, `${e.message} Reply with your API's base URL and example requests, one per line, for example GET /price?symbol=ADA`,
      { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  await startIntake(deps, task, key, {
    name: base.hostname,
    origin: base.origin,
    openapiUrl: base.proofUrl,
    samples: { base: base.base, lines: intake.lines },
    label: `your example requests for ${base.base}`,
    specText: async () => JSON.stringify(specFromSamples({ title: base.hostname, base: base.base, samples })),
    setupHint: `choose "I don't" (no OpenAPI file) on this setup page and paste the same base URL and example requests`,
    retryHint: "Reply with the corrected base URL and example requests to try again.",
  });
}

async function startIntake(deps: ConversationDeps, task: TaskRef, key: string, intake: Intake): Promise<void> {
  const existing = await apiForTask(deps.pool, task.taskId);
  if (existing && !existing.failed) {
    await say(deps.pool, task, key,
      `This task already has ${existing.name} in progress, and each task onboards one API. To sell another API, start a new task. Details: ${apiLink(deps.webBaseUrl, existing.id)}`,
      { apiId: existing.id });
    return;
  }
  const sellerId = await linkedSeller(deps.pool, task.sokosumiUserId);
  if (sellerId) {
    // This Sokosumi account signed in with its wallet on an earlier setup link, so the API can start right here.
    const apiId = await createTaskApi(deps.pool, {
      sellerId, taskId: task.taskId, name: intake.name, origin: intake.origin, openapiUrl: intake.openapiUrl,
      ...(intake.samples ? { samples: intake.samples } : {}),
    });
    await say(deps.pool, task, key, `Got your ${intake.samples ? "example requests" : "link"}. Reading ${intake.label} now.`, { apiId, step: "Read your file", status: "RUNNING" });
    return;
  }
  // First time: read it now, and ask for the one sign-in that ties the task to a wallet.
  let summary: string;
  try {
    const parsed = await parseOpenApi(await intake.specText());
    const what = intake.samples ? "Your example requests have" : "Your OpenAPI file has";
    if (parsed.operations.length === 0) throw new PermanentError(`${what} no endpoints we can sell yet${parsed.skipped.length ? ` (${parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ")})` : ""}.`);
    const list = parsed.operations.map((o, i) => `${i + 1}. ${o.method.toUpperCase()} ${o.path} (${o.opId})${o.llm.summary ? `: ${o.llm.summary}` : ""}`);
    summary = [
      `I read ${intake.samples ? intake.label : parsed.title || intake.name} and found ${parsed.operations.length} endpoints${parsed.skipped.length ? ` (I skipped ${parsed.skipped.length})` : ""}:`,
      ...list,
      `Suggested price: ${SUGGESTED_PRICE}. I write the promise (what a good answer looks like) from real test calls, which run after you prove you own the API.`,
      ...(parsed.authHint ? [`Your API needs a key (${describeAuthHint(parsed.authHint)}). You'll add it on the ownership page later. Never paste it in a comment.`] : []),
      `Next, sign in with your Cardano wallet (one signature, no payment) and ${intake.setupHint}: ${setupLink(deps.webBaseUrl, task.setupToken)}`,
      "After that, everything except proving ownership and approving the publish happens here in this task.",
    ].join("\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await say(deps.pool, task, key, `I couldn't read ${intake.label}: ${msg} ${intake.retryHint}`, { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  await say(deps.pool, task, key, summary, { step: "Read your file", status: "INPUT_REQUIRED" });
}
