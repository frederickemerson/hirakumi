import type pg from "pg";
import type { Db } from "../db.js";
import { PermanentError } from "../errors.js";
import { apiLink, ownershipLink, reviewLink, setupLink } from "../links.js";
import type { StructuredCall } from "../llm/claude.js";
import { mapReplyToChoice, type Offered } from "../llm/replyChoice.js";
import { enqueueMessage, type TaskStatus } from "../messages.js";
import type { HumanStep } from "../humanSteps.js";
import { parseOpenApi } from "../openapi/parse.js";
import { findLinks, formatCommand, formatTusdm, LinkError, parseCommand, SUGGESTED_PACK, validateOpenApiUrl, type Command } from "./replies.js";
import { apiForTask, confirmSell, createTaskApi, linkedSeller, listOps, opLine, savePrice, type ListedOp, type TaskApi } from "./sellerActions.js";

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

async function say(db: Db, task: TaskRef, key: string, body: string, o: { step?: HumanStep; status?: TaskStatus; apiId?: string | null } = {}) {
  await enqueueMessage(db, { apiId: o.apiId ?? null, taskId: task.taskId, body, taskStatus: o.status ?? null, dedupeKey: key, ...(o.step ? { step: o.step } : {}) });
}

/** The text a brand-new task arrived with (name, description, early comments). */
export async function handleBrief(deps: ConversationDeps, task: TaskRef, brief: string): Promise<void> {
  const links = findLinks(brief);
  if (links.length === 0) {
    await say(
      deps.pool, task, `setup:${task.taskId}`,
      `Hi! I'll put your API on the agent market. Reply here with the https link to your OpenAPI file, or open this setup link and paste it there (about 3 minutes, 4 clicks): ${setupLink(deps.webBaseUrl, task.setupToken)}`,
      { status: "INPUT_REQUIRED" },
    );
    return;
  }
  await handleLink(deps, task, links[0], `brief:${task.taskId}`);
}

/** One seller comment on a known task. */
export async function handleReply(deps: ConversationDeps, task: TaskRef, eventId: string, text: string): Promise<void> {
  const key = `reply:${eventId}`;
  const links = findLinks(text);
  if (links.length) return handleLink(deps, task, links[0], key);

  const api = await apiForTask(deps.pool, task.taskId);
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
      `There's no API on this task yet. Reply with the https link to your OpenAPI file. If you already sent it, sign in with your wallet and paste it on the setup page: ${setupLink(deps.webBaseUrl, task.setupToken)}`,
      { status: "INPUT_REQUIRED" });
    return;
  }
  if (api.failed) {
    await say(deps.pool, task, key, "Onboarding stopped at the step I described above. Fix it, then reply with your OpenAPI link again to start over.", { apiId: api.id, status: "INPUT_REQUIRED" });
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
      `Prove you own ${api.origin}. This step needs your Cardano wallet (one signature, no payment): ${ownershipLink(deps.webBaseUrl, api.id)}`,
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
  await say(deps.pool, task, key, helpFor(api, deps.webBaseUrl), { apiId: api.id });
}

/** What a reply may choose at this point (for the LLM mapping), or null when the coworker asked for nothing. */
function offeredFor(api: TaskApi, ops: ListedOp[]): Offered | null {
  if (api.state === "described" || api.state === "endpoints_confirmed") {
    return { kind: "sell", endpoints: ops.map((o) => ({ ref: o.ref, opId: o.opId, method: o.method, path: o.path })) };
  }
  if (api.state === "rule_built" || api.state === "priced") return { kind: "price" };
  return null;
}

function helpFor(api: TaskApi, web: string): string {
  switch (api.state) {
    case "intake":
    case "parsed":
      return "I'm still reading your OpenAPI file. I'll post here as soon as it's done.";
    case "described":
      return "Choose the endpoints to sell: reply `sell 1` with the numbers from my list (for example `sell 1 2`).";
    case "endpoints_confirmed":
      return `Next, prove you own the API. This step needs your Cardano wallet: ${ownershipLink(web, api.id)} (To change the endpoints first, reply \`sell\` with new numbers.)`;
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
    const apiId = await createTaskApi(deps.pool, { sellerId, taskId: task.taskId, name: link.hostname, origin: link.origin, openapiUrl: link.url });
    await say(deps.pool, task, key, `Got your link. Reading ${link.url} now.`, { apiId, step: "Read your file", status: "RUNNING" });
    return;
  }
  // First time: read the file now (SSRF-safe fetch), and ask for the one sign-in that ties the task to a wallet.
  let summary: string;
  try {
    const parsed = await parseOpenApi(await deps.fetchSpec(link.url));
    if (parsed.operations.length === 0) throw new PermanentError(`Your OpenAPI file has no endpoints we can sell yet${parsed.skipped.length ? ` (${parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ")})` : ""}.`);
    const list = parsed.operations.map((o, i) => `${i + 1}. ${o.method.toUpperCase()} ${o.path} (${o.opId})${o.llm.summary ? `: ${o.llm.summary}` : ""}`);
    summary = [
      `I read ${parsed.title || link.hostname} and found ${parsed.operations.length} endpoints${parsed.skipped.length ? ` (I skipped ${parsed.skipped.length})` : ""}:`,
      ...list,
      `Suggested price: ${SUGGESTED_PRICE}. I write the promise (what a good answer looks like) from real test calls, which run after you prove you own the API.`,
      `Next, sign in with your Cardano wallet (one signature, no payment) and paste the same link on this setup page: ${setupLink(deps.webBaseUrl, task.setupToken)}`,
      "After that, everything except proving ownership and approving the publish happens here in this task.",
    ].join("\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await say(deps.pool, task, key, `I couldn't read ${link.url}: ${msg} Reply with the corrected link to try again.`, { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  await say(deps.pool, task, key, summary, { step: "Read your file", status: "INPUT_REQUIRED" });
}
