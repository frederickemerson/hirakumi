import {
  AMBIGUOUS_PATH, judgeListingBase, listActiveOnOrigin, newId, parseSampleLines, SampleError, sha256Hex, specFromSamples, type QueryFn,
} from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import { enqueueMessage } from "../messages.js";
import { describeAuthHint, parseOpenApi, type ParseResult } from "../openapi/parse.js";
import { finishStep, runStep, type StepOutcome } from "../steps.js";

/** allowInsecure: an http://localhost base is accepted (local development only, ALLOW_INSECURE_UPSTREAM=1). */
export type ParseDeps = { pool: pg.Pool; fetchSpec: (url: string) => Promise<string>; now?: () => Date; allowInsecure?: boolean };

/**
 * Hosts that serve files, never the seller's API. An OpenAPI file there needs a full servers[0] URL: a relative one
 * (or none) would make the file host the API.
 */
const FILE_HOSTS = new Set([
  "raw.githubusercontent.com", "gist.githubusercontent.com", "github.com", "gist.github.com", "gitlab.com", "bitbucket.org", "cdn.jsdelivr.net",
]);

/**
 * Where the operations live (review I7): the API's origin and base path, from servers[0].url. The OpenAPI file is
 * not part of ownership (the seller proves the base URL with a response header), so it may be hosted anywhere.
 * An absolute servers[0] names the API wherever the file is. A relative one resolves against the file's link,
 * and no servers means the file's origin and "/". For example requests, `ref` is the base the seller gave.
 */
export function apiBase(serverUrl: string | null, ref: string, allowInsecure = false): { origin: string; pathPrefix: string } {
  let refUrl: URL;
  try {
    refUrl = new URL(ref);
  } catch {
    throw new PermanentError(`The link ${ref} is not a valid URL.`);
  }
  let absolute = false;
  if (serverUrl) {
    try {
      new URL(serverUrl);
      absolute = true;
    } catch { /* relative */ }
  }
  if (!absolute && FILE_HOSTS.has(refUrl.hostname)) {
    throw new PermanentError(
      `Your OpenAPI file is on ${refUrl.hostname}, which can't be where your API runs. ` +
        "Set the first servers URL in the file to your API's full base URL, for example https://api.example.com/v1, then try again.",
    );
  }
  let base: URL;
  try {
    base = new URL(serverUrl ?? "/", refUrl);
  } catch {
    throw new PermanentError(`The servers URL in your OpenAPI file is not a valid link: ${serverUrl}`);
  }
  const what = `Your API's base URL ${serverUrl ?? base.origin}`;
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !(allowInsecure && base.protocol === "http:" && local)) throw new PermanentError(`${what} must start with https://`);
  if (base.username || base.password) throw new PermanentError(`${what} has a username or password. Remove them.`);
  // "api.example.com." names the same host but is a different origin and listing base: one spelling only.
  if (base.hostname.endsWith(".")) throw new PermanentError(`${what} has a dot at the end of its host name. Remove it.`);
  if (base.search !== "" || base.hash !== "" || /[?#]/.test(serverUrl ?? "")) throw new PermanentError(`${what} has a ?query or #fragment. Use a plain base URL.`);
  if (/\{|%7b/i.test(serverUrl ?? "") || /%7b/i.test(base.pathname)) throw new PermanentError(`${what} has a {variable} with no default. Give it a default or write the full URL.`);
  if (AMBIGUOUS_PATH.test(base.pathname) || (serverUrl ?? "").includes("\\")) {
    throw new PermanentError(`${what} has an encoded slash, dot or a ';' in its path. Use a plain path.`);
  }
  // The ownership check requests exactly this base; an empty segment would make it a second spelling of another folder.
  if (base.pathname.includes("//")) throw new PermanentError(`${what} has two slashes in a row in its path. Use a plain path.`);
  const prefix = base.pathname.replace(/\/+$/, "");
  return { origin: base.origin, pathPrefix: prefix === "" ? "/" : prefix };
}

/**
 * One API, one listing (advisory): tell the seller now, not at the ownership step, when another account
 * already lists this base or one overlapping it. The check when ownership is proven is the authority.
 */
async function refuseIfListedByOther(pool: pg.Pool, apiId: string, origin: string, pathPrefix: string): Promise<void> {
  const query: QueryFn = async (text, params) => (await pool.query(text, params)).rows;
  const { rows } = await pool.query<{ seller_id: string }>(`select seller_id from apis where id = $1`, [apiId]);
  if (!rows[0]) return;
  const verdict = judgeListingBase({ sellerId: rows[0].seller_id, origin, pathPrefix }, await listActiveOnOrigin(query, origin, apiId));
  if (!verdict.ok && verdict.reason === "taken_by_other") throw new PermanentError(verdict.message);
}

type Samples = { base: string; lines: string };

/**
 * Any API without an OpenAPI file: build the document from the seller's example requests (checked again here,
 * not trusted from intake), then parse it like any other. servers[0] is the base, checked by apiBase like any other.
 */
function specTextFromSamples(s: Samples, name: string): string {
  try {
    return JSON.stringify(specFromSamples({ title: name, base: s.base, samples: parseSampleLines(s.lines) }));
  } catch (e) {
    if (e instanceof SampleError) throw new PermanentError(`Your example requests could not be read. ${e.message}`);
    throw e;
  }
}

/**
 * The seller adds the key on the ownership page (sealed to the gateway, never shown again). It is never asked for
 * in a comment: anyone on a Sokosumi task can read those.
 */
export function keyNote(parsed: Pick<ParseResult, "operations" | "authHint">): string {
  const n = parsed.operations.filter((o) => o.needsKey).length;
  if (!parsed.authHint || n === 0) return "";
  const which = n === parsed.operations.length ? "Your API needs a key" : `${n} of these endpoints need a key`;
  return ` ${which} (${describeAuthHint(parsed.authHint)}). Add it on the ownership page before you prove ownership. Never paste it in a comment.`;
}

export async function parseStep(deps: ParseDeps, apiId: string): Promise<StepOutcome> {
  return runStep(deps.pool, apiId, "parse", async () => {
    const { rows } = await deps.pool.query<{ openapi_url: string | null; name: string; samples: Samples | null }>(
      `select openapi_url, name, samples from apis where id = $1`, [apiId]);
    if (!rows[0]) throw new PermanentError(`API ${apiId} no longer exists.`);
    const { samples, openapi_url: openapiUrl } = rows[0];
    if (!samples && !openapiUrl) throw new PermanentError(`API ${apiId} has neither an OpenAPI link nor example requests.`);
    const fromSamples = samples !== null;
    const text = samples ? specTextFromSamples(samples, rows[0].name) : await deps.fetchSpec(openapiUrl!);
    const parsed = await parseOpenApi(text);
    // apis.origin was only a placeholder (the link's origin) until now: the base comes from servers[0].
    const { origin, pathPrefix } = apiBase(parsed.serverUrl, samples ? samples.base : openapiUrl!, deps.allowInsecure);
    await refuseIfListedByOther(deps.pool, apiId, origin, pathPrefix);
    if (parsed.operations.length === 0) {
      const why = parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ");
      throw new PermanentError(`Your ${fromSamples ? "example requests have" : "OpenAPI file has"} no endpoints we can sell yet${why ? ` (${why})` : ""}.`);
    }
    // With no name given, intake names the API after the link's host. The file may be on GitHub or a docs site,
    // so that name follows the API's own host now that it is known. A name the seller typed stays.
    const linkHost = openapiUrl ? new URL(openapiUrl).hostname : null;
    const name = linkHost !== null && rows[0].name === linkHost ? new URL(origin).hostname : rows[0].name;
    await withTx(deps.pool, async (c) => {
      const moved = await c.query(
        `update apis set state = 'parsed', openapi_sha256 = $2, path_prefix = $3, origin = $4, name = $5 where id = $1 and state = 'intake'`,
        [apiId, sha256Hex(text), pathPrefix, origin, name],
      );
      if (moved.rowCount !== 1) return;
      for (const op of parsed.operations) {
        await c.query(
          `insert into operations (id, api_id, op_id, method, path, input_schema) values ($1, $2, $3, $4, $5, $6::jsonb)
           on conflict (api_id, op_id) do nothing`,
          [newId("op"), apiId, op.opId, op.method, op.path, JSON.stringify(op.inputSchema)],
        );
      }
      await finishStep(c, apiId, "parse", { title: parsed.title, ops: parsed.operations.map((o) => o.llm), skipped: parsed.skipped, authHint: parsed.authHint });
      const skippedNote = parsed.skipped.length ? ` I skipped ${parsed.skipped.length} (${parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ")}).` : "";
      await enqueueMessage(c, {
        apiId,
        body: `I read your ${fromSamples ? "example requests" : "OpenAPI file"} and found ${parsed.operations.length} endpoints.${skippedNote}${keyNote(parsed)} Writing descriptions for buyers now.`,
        taskStatus: "RUNNING",
        dedupeKey: `parsed:${apiId}`,
        step: "Read your file",
      });
    });
  }, deps.now?.());
}
