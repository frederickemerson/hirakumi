import type postgres from "postgres";
import type { StoredUpstreamAuth, UpstreamAuthPlacement } from "@hirakumi/core";
import type { Sql } from "../db";

/** What the seller may see of a stored key: where it goes and its last characters. Never the sealed key. */
export type UpstreamAuthView = { in: UpstreamAuthPlacement; name: string; hint: string };
/** The coworker's guess from the OpenAPI file (parse step output "authHint"), to prefill the key form. */
export type AuthHint = { in: UpstreamAuthPlacement; name: string; prefix?: string };

const isPlacement = (v: unknown): v is UpstreamAuthPlacement => v === "header" || v === "query";

export async function getUpstreamAuth(sql: Sql, apiId: string): Promise<UpstreamAuthView | null> {
  // Only the three display fields leave the database; the sealed key is never selected here.
  const [row] = await sql<{ placement: unknown; name: unknown; hint: unknown }[]>`
    select upstream_auth->>'in' as placement, upstream_auth->>'name' as name, upstream_auth->>'hint' as hint
    from apis where id = ${apiId} and upstream_auth is not null`;
  if (!row || !isPlacement(row.placement) || typeof row.name !== "string") return null;
  return { in: row.placement, name: row.name, hint: typeof row.hint === "string" ? row.hint : "" };
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

/** True when a key was stored and is now gone. */
export async function clearUpstreamAuth(sql: Sql, apiId: string): Promise<boolean> {
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
  const h = row?.hint as { in?: unknown; name?: unknown; prefix?: unknown } | null | undefined;
  if (!h || typeof h !== "object" || !isPlacement(h.in) || typeof h.name !== "string" || !h.name) return null;
  return { in: h.in, name: h.name, ...(typeof h.prefix === "string" && h.prefix ? { prefix: h.prefix } : {}) };
}
