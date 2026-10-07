import { parse } from "tldts";
import {
  actPlaceholder, apiBaseUrl, normalizeSamplesBase, verifyRecordFor, parseSampleLinesWithWarnings, SampleError, specFromSamples, UpstreamTimeoutError,
  UpstreamTooLargeError,
} from "@hirakumi/core";
import type pg from "pg";
import type { Db } from "../db.js";
import { PermanentError } from "../errors.js";
import { linkWalletLink, statusPageLink } from "../links.js";
import { leakProblem, type LeakCheck } from "../leakCheck.js";
import type { StructuredCall } from "../llm/claude.js";
import { mapReplyToChoice, type Offered } from "../llm/replyChoice.js";
import { enqueueMessage, type TaskStatus } from "../messages.js";
import type { HumanStep } from "../humanSteps.js";
import { apiBase } from "../onboarding/parseStep.js";
import { phraseAsk } from "../onboarding/qaStep.js";
import { SpecNotServedError } from "../openapi/fetchSpec.js";
import { describeAuthHint, isOpenApiDocument, parseOpenApi, type AuthHint } from "../openapi/parse.js";
import {
  callsLinkASpec, findLinks, findSamplesIntake, formatCommand, formatTusdm, LinkError, likelySpecLink, linksToProbe, looksLikeSecret, MAX_LINK_PROBES,
  parseCommand, SUGGESTED_PACK, validateOpenApiUrl, type Command, type SamplesIntake,
} from "./replies.js";
import {
  addPhrase, apiAuthHint, apiForTask, confirmSell, createTaskApi, ensureVerifyCode, hasFreshDnsPass, linkedSeller, linkedWallet, listOps, opLine,
  opsNeedingPhrase, savedPack, savePrice, suggestedPhrases, walletTail, type ListedOp, type TaskApi,
} from "./sellerActions.js";

/**
 * The seller's side of a Sokosumi task: the whole onboarding happens in its comments. A link in the brief or a reply
 * starts it; typed replies the coworker asked for (`sell …`, `price …`, `phrase …`, `publish`) do every step that
 * needs no wallet. The coworker finds the DNS record itself and runs the leak check. A step that needs the owner's
 * wallet signature or the API's key gets a one-time link to one focused page (/act/<token>, written as a placeholder
 * the outbox fills in), and the first link of an account to a wallet the setup link. Every reply gets exactly one
 * answer (dedupe key per event).
 */
export type ConversationDeps = {
  pool: pg.Pool;
  webBaseUrl: string;
  fetchSpec: (url: string) => Promise<string>;
  /** Maps a free-text reply to an offered choice. null = typed replies only. */
  llm: StructuredCall | null;
  allowInsecure: boolean;
  /** Endpoints that need several keys at once are sold too (UPSTREAM_AUTH_V3, parseOpenApi). */
  multiPartKeys?: boolean;
  /** The leak check before the publish link (leakCheck.ts). Null: the link is sent and the publish step checks. */
  leakCheck?: LeakCheck | null;
};
export type TaskRef = { taskId: string; sokosumiUserId: string; setupToken: string };

const SUGGESTED_PRICE = `${formatTusdm(SUGGESTED_PACK.priceMicros)} tUSDM for ${SUGGESTED_PACK.calls} calls, and ${formatTusdm(SUGGESTED_PACK.escrowPriceMicros)} tUSDM per escrow job`;

/**
 * How ownership is proven, with the exact record: a DNS TXT record named _hirakumi.<host> holding the API's own code,
 * then one wallet signature. The API itself doesn't change. The code is not a secret (anyone can read DNS), so it is
 * safe in a task comment. Name is given the way DNS dashboards ask for it (the part before the domain) and in full.
 * Sokosumi renders comments as Markdown, so the record's fields are code spans: a bare `_hirakumi` turns into italics.
 * The coworker looks the record up itself (onboarding/dnsWatch.ts) and posts the signing link when it finds it.
 */
export function ownershipMessage(api: Pick<TaskApi, "origin" | "pathPrefix">, code: string): string {
  const rec = verifyRecordFor(api.origin);
  if (!rec.ok) return `Prove you own ${baseUrlOf(api)}: ${rec.detail} Give your API its own domain name, then reply here.`;
  const domain = parse(rec.host).domain;
  const short = domain && rec.name.endsWith(`.${domain}`) ? rec.name.slice(0, -(domain.length + 1)) : rec.name;
  return [
    `Prove you own ${rec.host}: add this DNS TXT record where your domain's DNS is managed (your API itself doesn't change):`,
    "- Type: `TXT`",
    short === rec.name ? `- Name: \`${rec.name}\`` : `- Name: \`${short}\` (the full name is \`${rec.name}\`)`,
    `- Value: \`${code}\``,
    "",
    "I look for it every 15 seconds and post here when I find it. Then you sign once with your Cardano wallet (no payment).",
  ].join("\n");
}

/** The API's address as the seller gave it: origin + path_prefix, origin + "/" for the root. */
export const baseUrlOf = (api: Pick<TaskApi, "origin" | "pathPrefix">) => apiBaseUrl(api);

/** Keys are added on the signing page (sealed so only the gateway reads them), never in a comment. */
const keyLine = (hint: AuthHint | null) =>
  hint ? `\nYour API needs a key (${describeAuthHint(hint)}): you add it on the page where you sign. Never paste it in a comment.` : "";

const NO_OPENAPI_HINT = "No OpenAPI file? Reply with your API's base URL and a few example requests, one per line, like GET /price?symbol=ADA";
const SEALED = "sealed so only the Hirakumi gateway can read it";

/** Neither stored nor repeated: the comment is only answered. */
const SECRET_WARNING =
  "Your message looks like it has a key, token or password in it, so I didn't use or save it. Please delete that comment, and change the key if others can see this task. " +
  "Never paste keys here.";

/**
 * Where the API's key goes for the API's state: on the page where the owner signs to prove ownership, or on a
 * one-time key link (/act) from then on. Never in a comment.
 */
function keyFormLine(api: TaskApi | null): string {
  if (!api) return "You'll add your API's key when you sign to prove you own it, after you choose endpoints.";
  switch (api.state) {
    case "endpoints_confirmed":
      return `You'll add your API's key on the page where you sign to prove you own it, ${SEALED}. I post that link here once I find your DNS record.`;
    case "ownership_verified":
      return api.failed
        ? `Add your API's key here, ${SEALED}. The test calls then run again: ${actPlaceholder("key")}`
        : `If the test calls need the key, add it here, ${SEALED}: ${actPlaceholder("key")}`;
    case "rule_built":
    case "priced":
    case "registering":
    case "live":
      return `Add your API's key here, ${SEALED}: ${actPlaceholder("key")}`;
    default:
      return api.failed
        ? "You'll add your API's key when you sign to prove you own it, after you start over and choose endpoints."
        : "You'll add your API's key when you sign to prove you own it, after you choose endpoints.";
  }
}

async function say(db: Db, task: TaskRef, key: string, body: string, o: { step?: HumanStep; status?: TaskStatus; apiId?: string | null } = {}) {
  await enqueueMessage(db, { apiId: o.apiId ?? null, taskId: task.taskId, body, taskStatus: o.status ?? null, dedupeKey: key, ...(o.step ? { step: o.step } : {}) });
}

/** The text a brand-new task arrived with (name, description, early comments). */
export async function handleBrief(deps: ConversationDeps, task: TaskRef, brief: string): Promise<void> {
  if (looksLikeSecret(brief)) {
    await say(deps.pool, task, `brief:${task.taskId}`,
      `${SECRET_WARNING} ${keyFormLine(null)} Now reply with your OpenAPI link, or your base URL and example requests, without the key.`,
      { status: "INPUT_REQUIRED" });
    return;
  }
  if (findLinks(brief).length === 0) {
    await say(
      deps.pool, task, `setup:${task.taskId}`,
      `Hi! I'll put your API on the agent market, right here in this task. Reply with the https link to your OpenAPI file. ${NO_OPENAPI_HINT}.`,
      { status: "INPUT_REQUIRED" },
    );
    return;
  }
  await handleLinks(deps, task, brief, `brief:${task.taskId}`);
}

/** One seller comment on a known task. */
export async function handleReply(deps: ConversationDeps, task: TaskRef, eventId: string, text: string): Promise<void> {
  const key = `reply:${eventId}`;
  const api = await apiForTask(deps.pool, task.taskId);
  if (looksLikeSecret(text)) {
    await say(deps.pool, task, key, `${SECRET_WARNING} ${keyFormLine(api)}`, { apiId: api?.id ?? null });
    return;
  }
  // Once an API is under way, a command wins ("price 2" with a note and a docs link under it). Any other reply with
  // a link is a new intake, which starts over only when there is no API yet or it failed.
  const underWay = api !== null && !api.failed;
  if (!(underWay && parseCommand(text)) && findLinks(text).length) return handleLinks(deps, task, text, key);

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

  if (cmd?.kind === "linkWallet") {
    await say(deps.pool, task, key, `${understood}${await linkWalletMessage(deps, task)}`, { apiId: api?.id ?? null });
    return;
  }
  if (!api) {
    const linked = (await linkedSeller(deps.pool, task.sokosumiUserId)) !== null;
    await say(deps.pool, task, key,
      `There's no API on this task yet. Reply with the https link to your OpenAPI file. ${NO_OPENAPI_HINT}.` +
        (linked || !task.setupToken ? "" : ` If you already sent it, sign in once with your Cardano wallet to link this task (no payment), and I start right away: ${linkWalletLink(deps.webBaseUrl, task.setupToken)}`),
      { status: "INPUT_REQUIRED" });
    return;
  }
  if (api.failed && api.failedStep === "qa" && api.state === "ownership_verified") {
    // Ownership is proven, so starting over would lose it. A refused test call (401/403) is fixed with the key form,
    // and saving the key there runs the test calls again.
    await say(deps.pool, task, key,
      `The test calls stopped at the step I described above. If your API needs a key, add it here (${SEALED}) and the test calls run again: ${actPlaceholder("key")} Never paste the key in a comment. ` +
        `For any other problem, fix your API, then reply with your ${api.intakeKind === "samples" ? "base URL and example requests" : "OpenAPI link"} again to start over.`,
      { apiId: api.id, step: "Test calls", status: "INPUT_REQUIRED" });
    return;
  }
  if (api.failed) {
    await say(deps.pool, task, key, `Onboarding stopped at the step I described above. Fix it, then reply with your ${api.intakeKind === "samples" ? "base URL and example requests" : "OpenAPI link"} again to start over.`, { apiId: api.id, status: "INPUT_REQUIRED" });
    return;
  }
  if (cmd?.kind === "publish") {
    if (api.state === "priced") {
      await say(deps.pool, task, key, `${understood}${await publishReadiness(deps, api)}`, { apiId: api.id, step: "Register on Masumi", status: "INPUT_REQUIRED" });
      return;
    }
    if (api.state === "rule_built") {
      await say(deps.pool, task, key, "Set a price first: reply `price 2` (or another amount, like `price 3.5 for 200 calls`).", { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
      return;
    }
  }
  if (cmd?.kind === "phrase") {
    const r = api.state === "rule_built" || api.state === "priced"
      ? await addPhrase(deps.pool, api.id, cmd.text)
      : { ok: false as const, error: "A phrase can be added after the test calls and before publishing." };
    if (!r.ok) {
      await say(deps.pool, task, key, `${understood}${r.error}`, { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
      return;
    }
    const next = (await phrasesStillNeeded(deps, api.id))
      ?? (api.state === "priced"
        ? await publishReadiness(deps, api)
        : `Next, reply \`price ${formatTusdm(SUGGESTED_PACK.priceMicros)}\` to accept the suggested price, or another amount (like \`price 3.5 for 200 calls\`).`);
    await say(deps.pool, task, key, `${understood}${r.message}\n${next}`, { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
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
      `${ownershipMessage(api, await ensureVerifyCode(deps.pool, api.id))}${keyLine(await apiAuthHint(deps.pool, api.id))}`,
      { apiId: api.id, step: "Prove ownership", status: "INPUT_REQUIRED" });
    return;
  }
  if (cmd?.kind === "price") {
    const r = await savePrice(deps.pool, api.id, cmd.priceText, cmd.calls);
    if (!r.ok) {
      await say(deps.pool, task, key, `${understood}${r.error}`, { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
      return;
    }
    const next = (await phrasesStillNeeded(deps, api.id)) ?? await publishReadiness(deps, { ...api, state: "priced" });
    await say(deps.pool, task, key, `${understood}${r.message}\n${next}`, { apiId: api.id, step: "Write the promise", status: "INPUT_REQUIRED" });
    return;
  }
  const hint = api.state === "endpoints_confirmed" ? await apiAuthHint(deps.pool, api.id) : null;
  const code = api.state === "endpoints_confirmed" ? await ensureVerifyCode(deps.pool, api.id) : null;
  const found = api.state === "endpoints_confirmed" && (await hasFreshDnsPass(deps.pool, api.id));
  await say(deps.pool, task, key, `${helpFor(api, deps.webBaseUrl, hint, code, found)}\nUsing a different wallet? Reply \`link wallet\`.`, { apiId: api.id });
}

/** What still needs a phrase before publishing (onboarding/qaStep.ts phraseAsk), or null when nothing does. */
async function phrasesStillNeeded(deps: ConversationDeps, apiId: string): Promise<string | null> {
  const needing = await opsNeedingPhrase(deps.pool, apiId);
  if (!needing.length) return null;
  const suggested = await suggestedPhrases(deps.pool, apiId);
  const { rows: [on] } = await deps.pool.query<{ n: number }>(`select count(*)::int as n from operations where api_id = $1 and enabled`, [apiId]);
  return needing.map((opId) => phraseAsk(opId, suggested[opId], on.n === 1, true)).join("\n");
}

/**
 * A priced API, before the publish link: the leak check first (the publish step runs it again), then the one-time
 * link to sign at the saved price. An API anyone can call for free gets the key link instead.
 */
async function publishReadiness(deps: ConversationDeps, api: TaskApi): Promise<string> {
  const phrases = await phrasesStillNeeded(deps, api.id);
  if (phrases) return phrases;
  let checked = "";
  if (deps.leakCheck) {
    let problem: string | null;
    try {
      const report = await deps.leakCheck(api.id);
      problem = leakProblem(report);
      if (problem && report.endpoints.some((e) => e.exposure === "open")) problem = `${problem} ${actPlaceholder("key")} Then reply \`publish\`.`;
    } catch (e) {
      console.error(`[conversation] leak check ${api.id}: ${e instanceof Error ? e.message : String(e)}`);
      problem = "I couldn't run the check that your API refuses calls without its key just now. Reply `publish` in a minute to try again.";
    }
    if (problem) return problem;
    checked = "Leak check passed: your API refuses calls without its key. ";
  }
  const pack = await savedPack(deps.pool, api.id);
  const price = pack ? ` at ${formatTusdm(pack.priceMicros)} tUSDM for ${pack.calls} calls` : "";
  return `${checked}Approve publishing${price} with your Cardano wallet (one signature, no payment): ${actPlaceholder("publish")}`;
}

/**
 * `link wallet`: the setup page in link mode moves this Sokosumi account (and its listings that are not live yet) to
 * the wallet signed in there. The setup token is posted only here and in the setup messages, never elsewhere.
 */
async function linkWalletMessage(deps: ConversationDeps, task: TaskRef): Promise<string> {
  if (!task.setupToken) return "This task has no setup link, so I can't move your Sokosumi account to another wallet from here.";
  const addr = await linkedWallet(deps.pool, task.sokosumiUserId);
  return "Open this link signed in with the wallet you want to use, then confirm. " +
    "Your Sokosumi account and its listings that are not live yet move to that wallet. " +
    `${addr ? `It's currently linked to ${walletTail(addr)}.` : "It isn't linked to a wallet yet."}\n${linkWalletLink(deps.webBaseUrl, task.setupToken)}`;
}

/** What a reply may choose at this point (for the LLM mapping), or null when the coworker asked for nothing. */
function offeredFor(api: TaskApi, ops: ListedOp[]): Offered | null {
  if (api.state === "described" || api.state === "endpoints_confirmed") {
    return { kind: "sell", endpoints: ops.map((o) => ({ ref: o.ref, opId: o.opId, method: o.method, path: o.path })) };
  }
  if (api.state === "rule_built" || api.state === "priced") return { kind: "price" };
  return null;
}

function helpFor(api: TaskApi, web: string, hint: AuthHint | null, code: string | null, dnsFound: boolean): string {
  switch (api.state) {
    case "intake":
    case "parsed":
      return `I'm still reading your ${api.intakeKind === "samples" ? "example requests" : "OpenAPI file"}. I'll post here as soon as it's done.`;
    case "described":
      return "Choose the endpoints to sell: reply `sell 1` with the numbers from my list (for example `sell 1 2`).";
    case "endpoints_confirmed":
      if (dnsFound) {
        return `I found your DNS record. Sign once with your Cardano wallet to prove you own the API (no payment)${hint ? " and add its key there" : ""}: ${actPlaceholder("ownership")}`;
      }
      return `Next: ${ownershipMessage(api, code ?? "")}${keyLine(hint)} (To change the endpoints first, reply \`sell\` with new numbers.)`;
    case "ownership_verified":
      return "Test calls are running. I'll post the promise and a suggested price here when they're done.";
    case "rule_built":
      return "Reply `price 2` to set the pack price in tUSDM (or `price 3.5 for 200 calls`). Then I send you the link to approve publishing.";
    case "priced":
      return "Reply `publish` and I check your API, then send you the link to approve publishing (one signature). To change the price, reply `price` again.";
    case "registering":
      return "Your API is being registered on Masumi. I'll post here when it's Live.";
    case "live":
      return `Your API is Live. Its public page: ${statusPageLink(web, api.id)}`;
    default:
      return "I'll post here when there is something for you to do.";
  }
}

/** The step 2 prompt on a Sokosumi task: the numbered endpoint list and how to choose by reply. */
export function chooseEndpointsPrompt(ops: ListedOp[], sellable: number): string {
  return [
    `Found ${ops.length} endpoints; ${sellable} look sellable (read-only):`,
    ...ops.map(opLine),
    // Sokosumi renders Markdown: without a blank line this sentence folds into the last list item.
    "",
    "Next, choose the endpoints to sell: reply `sell 1` with their numbers (for example `sell 1 2`). " +
      "Endpoints marked [may change data] also need `readonly` at the end, to confirm they change nothing on your server.",
  ].join("\n");
}

/** What the seller sent to start onboarding: an OpenAPI link, or (any API) a base URL and example requests. */
type Intake = {
  name: string;
  /** For an OpenAPI link, the link's origin: a placeholder until the parse step reads servers[0]. */
  origin: string;
  /** The OpenAPI file, or null for example requests. */
  openapiUrl: string | null;
  samples?: { base: string; lines: string };
  /** "your example requests for https://…" or the link: what "Reading … now" and "I couldn't read …" name. */
  label: string;
  specText: () => Promise<string>;
  /** The message it came from: kept while a first-time seller links their wallet, then read again. */
  source: string;
  /** How to retry after an error. */
  retryHint: string;
  /** Said first, such as why example lines next to an OpenAPI link were ignored. */
  note?: string;
};

/** What fetching one link showed: an OpenAPI (or Swagger) document, something else, or no answer at all. */
type Probe =
  | { link: string; url: string; kind: "spec"; text: string }
  | { link: string; url: string; kind: "notSpec"; reason: string }
  | { link: string; url: string; kind: "failed"; problem: string };

const SAMPLE_EXAMPLE = "GET /price?symbol=ADA";

/** Why a fetch got no answer, as the end of "I couldn't read <link>: …". */
function fetchProblem(e: unknown): string {
  if (e instanceof UpstreamTimeoutError) return "it didn't answer within 15 seconds.";
  if (e instanceof UpstreamTooLargeError) return "it is larger than 1 MB, the limit for an OpenAPI file.";
  return e instanceof Error ? e.message : String(e);
}

/** Why an answer is not an OpenAPI file, as the end of "it didn't look like an OpenAPI file (…)". */
function notSpecReason(text: unknown): string {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return "it was empty";
  if (s.startsWith("<")) return "it is a web page";
  if (s.startsWith("{") || s.startsWith("[")) return "it is JSON with no openapi version";
  return "it has no openapi version";
}

/** Fetches one link with the SSRF-safe spec fetcher (same limits as the parse step) and says what it is. */
async function probeLink(deps: ConversationDeps, link: string, url: string): Promise<Probe> {
  let text: string;
  try {
    text = await deps.fetchSpec(url);
  } catch (e) {
    if (e instanceof SpecNotServedError) {
      return { link, url, kind: "notSpec", reason: e.status >= 300 && e.status < 400 ? "it redirects to another address" : `it answered with HTTP ${e.status}` };
    }
    return { link, url, kind: "failed", problem: fetchProblem(e) };
  }
  // Valid or not: an OpenAPI or Swagger document is read as one, so its own errors (Swagger 2.0, invalid) are told.
  if (isOpenApiDocument(text)) return { link, url, kind: "spec", text };
  return { link, url, kind: "notSpec", reason: notSpecReason(text) };
}

/**
 * A brief or reply with links. Each link is fetched (at most MAX_LINK_PROBES, likely OpenAPI files first), since a
 * link's name doesn't tell an OpenAPI file from a base URL (/v3/api-docs, /api-json, /openapi). An OpenAPI file wins,
 * even over example request lines next to it. Otherwise example lines make a samples intake, and a link alone gets
 * the samples prompt: "that isn't an OpenAPI file; if it's your base URL, send example requests".
 */
async function handleLinks(deps: ConversationDeps, task: TaskRef, text: string, key: string): Promise<void> {
  const existing = await apiForTask(deps.pool, task.taskId);
  if (existing && !existing.failed) return alreadyInProgress(deps, task, key, existing);
  const samples = findSamplesIntake(text);
  const valid: { link: string; url: string }[] = [];
  let refused: LinkError | null = null;
  for (const link of linksToProbe(text)) {
    try {
      valid.push({ link, url: validateOpenApiUrl(link, deps.allowInsecure).url });
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      refused ??= e;
    }
  }
  const probes = await Promise.all(valid.slice(0, MAX_LINK_PROBES).map((v) => probeLink(deps, v.link, v.url)));
  const spec = probes.find((p) => p.kind === "spec");
  if (spec?.kind === "spec") {
    return startOpenApi(deps, task, key, spec.url, spec.text,
      samples ? "That link is an OpenAPI file, so I read it and ignored your example requests. " : "", text);
  }
  if (samples) {
    // A link the seller means as their OpenAPI file, but it couldn't be fetched: the fetch error is the answer.
    const failed = probes.find((p) => p.kind === "failed" && (likelySpecLink(p.link) || callsLinkASpec(text)));
    if (failed?.kind === "failed") return couldNotRead(deps, task, key, failed);
    return handleSamples(deps, task, samples, key, text);
  }
  const notSpec = probes.find((p) => p.kind === "notSpec");
  if (notSpec?.kind === "notSpec") {
    await say(deps.pool, task, key,
      `I opened ${notSpec.link}, but it didn't look like an OpenAPI file (${notSpec.reason}). ` +
        `If it's your API's base URL, reply with it and a few example requests, one per line, like this:\n${notSpec.link}\n${SAMPLE_EXAMPLE}\n` +
        "If it should be your OpenAPI file, check the link and send it again.",
      { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  const failed = probes.find((p) => p.kind === "failed");
  if (failed?.kind === "failed") return couldNotRead(deps, task, key, failed);
  // No link passed the web's link rules, so nothing was fetched.
  await say(deps.pool, task, key, `${refused?.message ?? "Paste the link to your OpenAPI description."} Reply with the public https link to your OpenAPI file.`,
    { step: "Read your file", status: "INPUT_REQUIRED" });
}

async function couldNotRead(deps: ConversationDeps, task: TaskRef, key: string, p: { link: string; problem: string }): Promise<void> {
  await say(deps.pool, task, key, `I couldn't read ${p.link}: ${p.problem} Reply with the corrected link to try again. ${NO_OPENAPI_HINT}.`,
    { step: "Read your file", status: "INPUT_REQUIRED" });
}

/** An OpenAPI file, already fetched: start onboarding (linked seller) or read it and ask for the sign-in. */
async function startOpenApi(deps: ConversationDeps, task: TaskRef, key: string, url: string, text: string, note: string, source: string): Promise<void> {
  const u = new URL(url);
  await startIntake(deps, task, key, {
    name: u.hostname,
    origin: u.origin,
    openapiUrl: url,
    label: url,
    specText: async () => text,
    source,
    retryHint: `Reply with the corrected link to try again. ${NO_OPENAPI_HINT}.`,
    note,
  });
}

/**
 * A base URL and example requests (no OpenAPI file): checked here with the same rules as the setup page. Nothing
 * is fetched: the endpoints come from the lines themselves.
 */
async function handleSamples(deps: ConversationDeps, task: TaskRef, intake: SamplesIntake, key: string, source: string): Promise<void> {
  if ("choices" in intake) {
    await say(deps.pool, task, key,
      `I found more than one link: ${intake.choices.join(" and ")}. Which one is your API's base URL? ` +
        "Reply with just that link, then your example requests, one per line.",
      { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  let base: ReturnType<typeof normalizeSamplesBase>;
  let samples: ReturnType<typeof parseSampleLinesWithWarnings>["samples"];
  let keyWarnings: string[];
  try {
    base = normalizeSamplesBase(intake.base, deps.allowInsecure);
    ({ samples, warnings: keyWarnings } = parseSampleLinesWithWarnings(intake.lines));
  } catch (e) {
    if (!(e instanceof SampleError)) throw e;
    await say(deps.pool, task, key, `${e.message} Reply with your API's base URL and example requests, one per line, for example GET /price?symbol=ADA`,
      { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  await startIntake(deps, task, key, {
    name: base.hostname,
    origin: base.origin,
    openapiUrl: null,
    samples: { base: base.base, lines: intake.lines },
    label: `your example requests for ${base.base}`,
    specText: async () => JSON.stringify(specFromSamples({ title: base.hostname, base: base.base, samples })),
    source,
    retryHint: "Reply with the corrected base URL and example requests to try again.",
    // Lines that may hold a key are read with a warning: a name or a value's shape can't prove a key.
    ...(keyWarnings.length ? { note: `${keyWarnings.join(" ")} ` } : {}),
  });
}

async function alreadyInProgress(deps: ConversationDeps, task: TaskRef, key: string, existing: TaskApi): Promise<void> {
  await say(deps.pool, task, key,
    `This task already has ${existing.name} in progress, and each task onboards one API. To sell another API, start a new task.`,
    { apiId: existing.id });
}

async function startIntake(deps: ConversationDeps, task: TaskRef, key: string, intake: Intake): Promise<void> {
  const existing = await apiForTask(deps.pool, task.taskId);
  if (existing && !existing.failed) return alreadyInProgress(deps, task, key, existing);
  const note = intake.note ?? "";
  const sellerId = await linkedSeller(deps.pool, task.sokosumiUserId);
  if (sellerId) {
    // This Sokosumi account signed in with its wallet on an earlier setup link, so the API can start right here.
    const apiId = await createTaskApi(deps.pool, {
      sellerId, taskId: task.taskId, name: intake.name, origin: intake.origin, openapiUrl: intake.openapiUrl,
      ...(intake.samples ? { samples: intake.samples } : {}),
    });
    await say(deps.pool, task, key, `${note}Got your ${intake.samples ? "example requests" : "link"}. Reading ${intake.label} now.`, { apiId, step: "Read your file", status: "RUNNING" });
    return;
  }
  // First time: read it now, and ask for the one sign-in that ties the task to a wallet.
  let summary: string;
  try {
    const parsed = await parseOpenApi(await intake.specText(), { multiPartKeys: deps.multiPartKeys ?? false });
    const what = intake.samples ? "Your example requests have" : "Your OpenAPI file has";
    // The same base rules as the parse step, so a file host with no full servers URL is told now, not after sign-in.
    apiBase(parsed.serverUrl, intake.openapiUrl ?? intake.samples!.base, deps.allowInsecure);
    if (parsed.operations.length === 0) throw new PermanentError(`${what} no endpoints we can sell yet${parsed.skipped.length ? ` (${parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ")})` : ""}.`);
    const list = parsed.operations.map((o, i) => `${i + 1}. ${o.method.toUpperCase()} ${o.path} (${o.opId})${o.llm.summary ? `: ${o.llm.summary}` : ""}`);
    summary = [
      `${note}I read ${intake.samples ? intake.label : parsed.title || intake.name} and found ${parsed.operations.length} endpoints${parsed.skipped.length ? ` (I skipped ${parsed.skipped.length})` : ""}:`,
      ...list,
      `Suggested price: ${SUGGESTED_PRICE}. I write the promise (what a good answer looks like) from real test calls, which run after you prove you own the API.`,
      ...(parsed.authHint ? [`Your API needs a key (${describeAuthHint(parsed.authHint)}). You'll add it when you sign to prove you own the API. Never paste it in a comment.`] : []),
    ].join("\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await say(deps.pool, task, key, `${note}I couldn't read ${intake.label}: ${msg} ${intake.retryHint}`, { step: "Read your file", status: "INPUT_REQUIRED" });
    return;
  }
  // Read again once the wallet is linked (sokosumi/inbox.ts resumeLinkedIntakes), so the seller sends nothing twice.
  await deps.pool.query(`update coworker_tasks set pending_intake = $2 where task_id = $1`, [task.taskId, intake.source]);
  await say(deps.pool, task, key, summary, { step: "Read your file", status: "RUNNING" });
  // Its own comment, like every later signing step: one link, sign, close, and the task carries on here.
  await say(deps.pool, task, `${key}:link-wallet`, [
    "Next: link your wallet. Sign once with your Cardano wallet, or with Google or email (no payment), then close the tab. I continue right here.",
    linkWalletLink(deps.webBaseUrl, task.setupToken),
    "",
    "Everything else happens in this task; you only open a link when your wallet has to sign.",
  ].join("\n"), { status: "INPUT_REQUIRED" });
}

/**
 * First-time sellers whose intake waits while they link their wallet (the setup link): once their Sokosumi account
 * is linked, the intake is read again as if just sent, and onboarding starts. Each waiting intake is claimed once.
 */
export async function resumeLinkedIntakes(deps: ConversationDeps): Promise<number> {
  const { rows } = await deps.pool.query<{ task_id: string; sokosumi_user_id: string; setup_token: string }>(
    `select t.task_id, t.sokosumi_user_id, t.setup_token from coworker_tasks t
     where t.pending_intake is not null and exists (select 1 from sellers s where s.sokosumi_user_id = t.sokosumi_user_id)
     order by t.created_at limit 20`,
  );
  let resumed = 0;
  for (const r of rows) {
    const { rows: [claimed] } = await deps.pool.query<{ text: string }>(
      `with old as (select task_id, pending_intake from coworker_tasks where task_id = $1 and pending_intake is not null for update)
       update coworker_tasks t set pending_intake = null from old where t.task_id = old.task_id returning old.pending_intake as text`, [r.task_id]);
    if (!claimed) continue;
    const task: TaskRef = { taskId: r.task_id, sokosumiUserId: r.sokosumi_user_id, setupToken: r.setup_token };
    if (await apiForTask(deps.pool, task.taskId)) continue; // started meanwhile (the website's setup form)
    await handleLinks(deps, task, claimed.text, `linked:${r.task_id}:${Date.now()}`);
    resumed++;
  }
  return resumed;
}
