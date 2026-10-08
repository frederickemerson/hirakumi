import type postgres from "postgres";
import type { StoredUpstreamAuth, UpstreamAuthPlacement } from "@hirakumi/core";
import type { Sql } from "../db";
import { hasAnyApiSchema } from "./schema";

/** What the seller may see of one stored key part: where it goes and its last characters. Never the sealed key. */
export type UpstreamAuthSetting = { in: UpstreamAuthPlacement; name: string; hint: string };
/** One part of a bag as the seller sees it: `fixed` marks public fixed text (a version header), whose hint is "". */
export type UpstreamAuthPart = UpstreamAuthSetting & { fixed?: true };
/**
 * A stored key as the seller sees it: one header or query parameter (hks2, the shape from before bags), or the
 * parts of a bag (hks3), told apart by `"parts" in view`.
 */
export type UpstreamAuthView = UpstreamAuthSetting | { parts: UpstreamAuthPart[] };
/** The coworker's guess from the OpenAPI file (parse step output "authHint"), to prefill the key form. */
/** One place the key goes (prefix: a word before it, "Bearer "). */
export type AuthHintPart = { in: UpstreamAuthPlacement; name: string; prefix?: string };
/** Where the OpenAPI file says the key goes; `parts` when it needs several at once (the first part is in, name). */
export type AuthHint = AuthHintPart & { parts?: AuthHintPart[] };

const isPlacement = (v: unknown): v is UpstreamAuthPlacement => v === "header" || v === "query";

export async function getUpstreamAuth(sql: Sql, apiId: string): Promise<UpstreamAuthView | null> {
  // Before migration 0014 no key can be stored (lib/repo/schema.ts).
  if (!(await hasAnyApiSchema(sql))) return null;
  // Only the display fields leave the database; the sealed key is never selected here (only whether it is a bag).
  const [row] = await sql<{ placement: unknown; name: unknown; hint: unknown; bag: boolean; parts: unknown }[]>`
    select upstream_auth->>'in' as placement, upstream_auth->>'name' as name, upstream_auth->>'hint' as hint,
      (upstream_auth->>'v' = '3' or left(upstream_auth->>'sealed', 5) = 'hks3.') is true as bag,
      upstream_auth->'parts' as parts
    from apis where id = ${apiId} and upstream_auth is not null`;
  if (!row) return null;
  if (row.bag) {
    const parts = Array.isArray(row.parts) ? row.parts.map(part) : [];
    return parts.length > 0 && parts.every((p) => p !== null) ? { parts: parts as UpstreamAuthPart[] } : null;
  }
  return setting({ in: row.placement, name: row.name, hint: row.hint });
}

/** One bag part's display fields, with the fixed-text flag, or null when the row doesn't hold them. */
function part(raw: unknown): UpstreamAuthPart | null {
  const p = setting(raw);
  return p && (raw as { fixed?: unknown }).fixed === true ? { ...p, fixed: true } : p;
}

/** One part's display fields, or null when the row doesn't hold them. */
function setting(raw: unknown): UpstreamAuthSetting | null {
  const p = raw as { in?: unknown; name?: unknown; hint?: unknown } | null;
  if (!p || typeof p !== "object" || !isPlacement(p.in) || typeof p.name !== "string") return null;
  return { in: p.in, name: p.name, hint: typeof p.hint === "string" ? p.hint : "" };
}

/**
 * False when nothing was stored: the API was retired or deleted after the route read it (a retire or delete
 * committing in between must not get the key written back), or it is not this seller's.
 */
export async function setUpstreamAuth(sql: Sql, a: { apiId: string; sellerId: string }, stored: StoredUpstreamAuth): Promise<boolean> {
  const rows = await sql`
    update apis set upstream_auth = ${sql.json(stored as unknown as postgres.JSONValue)}
    where id = ${a.apiId} and seller_id = ${a.sellerId} and state <> 'retired' and deleted_at is null
    returning id`;
  return rows.length > 0;
}

/**
 * What buyers can see of an API's example values: the seller's example requests (apis.samples lines), every
 * endpoint's input schema with its examples (operations.input_schema, built from the OpenAPI file or the example
 * requests), and the OpenAPI file's summaries and parameter descriptions as the parse step kept them
 * (onboard_steps(step='parse').output.ops). A key found here is public already.
 */
export async function publicExampleTexts(sql: Sql, apiId: string): Promise<string[]> {
  const [api] = await sql<{ lines: string | null }[]>`select samples->>'lines' as lines from apis where id = ${apiId}`;
  const ops = await sql<{ schema: string | null }[]>`select input_schema::text as schema from operations where api_id = ${apiId}`;
  const [parsed] = await sql<{ ops: string | null }[]>`
    select (output->'ops')::text as ops from onboard_steps where api_id = ${apiId} and step = 'parse'`;
  return [api?.lines ?? null, ...ops.map((o) => o.schema), parsed?.ops ?? null]
    .filter((t): t is string => typeof t === "string" && t !== "");
}

/** True when a key was stored and is now gone. */
export async function clearUpstreamAuth(sql: Sql, apiId: string): Promise<boolean> {
  if (!(await hasAnyApiSchema(sql))) return false;
  const rows = await sql`update apis set upstream_auth = null where id = ${apiId} and upstream_auth is not null returning id`;
  return rows.length > 0;
}

/**
 * Test calls that failed for good (often a 401 or 403 before the key was added) run again once the key changes.
 * Only while the API waits on them; the coworker picks the step up again as pending with a fresh attempt count.
 * Never for an API replaced on its Sokosumi task (the seller started over there, so a newer API on the same task
 * exists): running it again would post its results to the task next to the new one's.
 */
export async function retryFailedQa(sql: Sql, apiId: string): Promise<boolean> {
  const rows = await sql`
    update onboard_steps set status = 'pending', attempts = 0, output = coalesce(output, '{}'::jsonb) - 'error', updated_at = now()
    where api_id = ${apiId} and step = 'qa' and status = 'failed'
      and exists (
        select 1 from apis a where a.id = ${apiId} and a.state = 'ownership_verified'
          and not exists (
            select 1 from apis b
            where b.sokosumi_task_id = a.sokosumi_task_id and b.id <> a.id and b.created_at > a.created_at))
    returning api_id`;
  return rows.length > 0;
}

export async function getAuthHint(sql: Sql, apiId: string): Promise<AuthHint | null> {
  const [row] = await sql<{ hint: unknown }[]>`
    select output->'authHint' as hint from onboard_steps where api_id = ${apiId} and step = 'parse'`;
  const h = row?.hint as { in?: unknown; name?: unknown; prefix?: unknown; parts?: unknown } | null | undefined;
  const part = hintPart(h);
  if (!part) return null;
  const parts = Array.isArray(h!.parts) ? h!.parts.map(hintPart) : [];
  // Several parts (the coworker's parser) only when every one reads; else the first part alone.
  return parts.length >= 2 && parts.length <= 4 && parts.every(Boolean) ? { ...part, parts: parts as AuthHintPart[] } : part;
}

function hintPart(v: unknown): AuthHintPart | null {
  const h = v as { in?: unknown; name?: unknown; prefix?: unknown } | null | undefined;
  if (!h || typeof h !== "object" || !isPlacement(h.in) || typeof h.name !== "string" || !h.name) return null;
  return { in: h.in, name: h.name, ...(typeof h.prefix === "string" && h.prefix ? { prefix: h.prefix } : {}) };
}
