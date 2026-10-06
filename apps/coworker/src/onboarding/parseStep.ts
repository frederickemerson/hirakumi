import { newId, sha256Hex } from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "../db.js";
import { PermanentError } from "../errors.js";
import { enqueueMessage } from "../messages.js";
import { parseOpenApi } from "../openapi/parse.js";
import { finishStep, runStep, type StepOutcome } from "../steps.js";

export type ParseDeps = { pool: pg.Pool; fetchSpec: (url: string) => Promise<string>; now?: () => Date };

/** intake → parsed: fetch + parse the spec, insert operations (all disabled), save the LLM context. */
/**
 * Where the operations live (review I7). servers[0].url may be absolute or relative to the OpenAPI file.
 * Ownership is proven for the file's host only, so a server on another host is refused.
 */
function serverPathPrefix(serverUrl: string | null, openapiUrl: string, origin: string): string {
  if (!serverUrl) return "/";
  let base: URL;
  try { base = new URL(serverUrl, openapiUrl); } catch { throw new PermanentError(`The servers URL in your OpenAPI file is not a valid link: ${serverUrl}`); }
  if (base.origin !== new URL(origin).origin) {
    throw new PermanentError(
      `Your OpenAPI file says the API runs on ${base.origin}, but the file itself is on ${new URL(origin).origin}. Ownership is proven for the file's host, so host the OpenAPI file on ${base.origin} and paste that link instead.`,
    );
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return prefix === "" ? "/" : prefix;
}

export async function parseStep(deps: ParseDeps, apiId: string): Promise<StepOutcome> {
  return runStep(deps.pool, apiId, "parse", async () => {
    const { rows } = await deps.pool.query<{ openapi_url: string; origin: string }>(`select openapi_url, origin from apis where id = $1`, [apiId]);
    if (!rows[0]) throw new PermanentError(`API ${apiId} no longer exists.`);
    const text = await deps.fetchSpec(rows[0].openapi_url);
    const parsed = await parseOpenApi(text);
    const pathPrefix = serverPathPrefix(parsed.serverUrl, rows[0].openapi_url, rows[0].origin);
    if (parsed.operations.length === 0) {
      const why = parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ");
      throw new PermanentError(`Your OpenAPI file has no endpoints we can sell yet${why ? ` (${why})` : ""}.`);
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
      await finishStep(c, apiId, "parse", { title: parsed.title, ops: parsed.operations.map((o) => o.llm), skipped: parsed.skipped });
      const skippedNote = parsed.skipped.length ? ` I skipped ${parsed.skipped.length} (${parsed.skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`).join("; ")}).` : "";
      await enqueueMessage(c, {
        apiId,
        body: `I read your OpenAPI file and found ${parsed.operations.length} endpoints.${skippedNote} Writing descriptions for buyers now.`,
        taskStatus: "RUNNING",
        dedupeKey: `parsed:${apiId}`,
      });
    });
  }, deps.now?.());
}
