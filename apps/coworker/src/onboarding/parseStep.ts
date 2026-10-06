import {
  checkSpecBinding, judgeListingBase, listActiveOnOrigin, newId, parseSampleLines, SampleError, sha256Hex, specFromSamples, type QueryFn,
} from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import { enqueueMessage } from "../messages.js";
import { describeAuthHint, parseOpenApi, type ParseResult } from "../openapi/parse.js";
import { finishStep, runStep, type StepOutcome } from "../steps.js";

export type ParseDeps = { pool: pg.Pool; fetchSpec: (url: string) => Promise<string>; now?: () => Date };

/** intake → parsed: fetch + parse the spec, insert operations (all disabled), save the LLM context. */
/**
 * Where the operations live (review I7). servers[0].url may be absolute or relative to the OpenAPI file.
 * The seller proves ownership by adding a code (x-hirakumi-verify) to this OpenAPI file, which only vouches
 * for APIs on the file's own origin and at or under its folder. A server elsewhere is refused now, before
 * the seller reaches the ownership step (the gateway re-checks the same rule when it reads the code).
 */
function serverPathPrefix(serverUrl: string | null, openapiUrl: string, origin: string): string {
  if (!serverUrl) return checked("/", null, openapiUrl, origin);
  let base: URL;
  try { base = new URL(serverUrl, openapiUrl); } catch { throw new PermanentError(`The servers URL in your OpenAPI file is not a valid link: ${serverUrl}`); }
  if (base.origin !== new URL(origin).origin) {
    throw new PermanentError(
      `Your OpenAPI file says the API runs on ${base.origin}, but the file itself is on ${new URL(origin).origin}. The ownership code in your OpenAPI file only covers its own host, so host the OpenAPI file on ${base.origin} and paste that link instead.`,
    );
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return checked(prefix === "" ? "/" : prefix, serverUrl, openapiUrl, origin);
}

function checked(pathPrefix: string, serverUrl: string | null, openapiUrl: string, origin: string): string {
  const binding = checkSpecBinding({ openapiUrl, origin, pathPrefix, serverUrl });
  if (!binding.ok) throw new PermanentError(binding.detail);
  return pathPrefix;
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
 * not trusted from intake), then parse it like any other. servers[0] is the base, so the folder binding with
 * the proof file (openapi_url) is checked the same way.
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
    const { rows } = await deps.pool.query<{ openapi_url: string; origin: string; name: string; samples: Samples | null }>(
      `select openapi_url, origin, name, samples from apis where id = $1`, [apiId]);
    if (!rows[0]) throw new PermanentError(`API ${apiId} no longer exists.`);
    const fromSamples = rows[0].samples !== null;
    const text = fromSamples ? specTextFromSamples(rows[0].samples!, rows[0].name) : await deps.fetchSpec(rows[0].openapi_url);
    const parsed = await parseOpenApi(text);
    const pathPrefix = serverPathPrefix(parsed.serverUrl, rows[0].openapi_url, rows[0].origin);
    await refuseIfListedByOther(deps.pool, apiId, rows[0].origin, pathPrefix);
    if (parsed.operations.length === 0) {
      const why = parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ");
      throw new PermanentError(`Your ${fromSamples ? "example requests have" : "OpenAPI file has"} no endpoints we can sell yet${why ? ` (${why})` : ""}.`);
    }
    await withTx(deps.pool, async (c) => {
      const moved = await c.query(`update apis set state = 'parsed', openapi_sha256 = $2, path_prefix = $3 where id = $1 and state = 'intake'`, [apiId, sha256Hex(text), pathPrefix]);
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
