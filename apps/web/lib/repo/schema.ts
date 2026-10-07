import type postgres from "postgres";
import type { Sql } from "../db";
import { env } from "../env";
import { errorJson } from "../http";

/**
 * Deploy order: the web may start before migration 0014 (example requests, sellers' keys, the X-Hirakumi-Verify
 * proof) has run. Until it has, the web reads apis without intake_kind, samples and upstream_auth, hides the key
 * form and the example requests option, and the routes that need those columns (or challenges of kind 'header')
 * answer 503 with UPDATING instead of failing.
 *
 * Checked once per process. A missing column is checked again every RECHECK_MS, so the web picks the migration
 * up without a restart; once present it is never checked again (migrations only add).
 */
export const UPDATING = "This part of Hirakumi is being updated. Try again in a few minutes.";

const RECHECK_MS = 60_000;

type Check = { ready: boolean; at: number; pending: Promise<boolean> | null };
const g = globalThis as unknown as { __hirakumiAnyApiSchema?: Check };

/** True once migration 0014 has run (apis.intake_kind exists). */
export async function hasAnyApiSchema(sql: Sql | postgres.TransactionSql): Promise<boolean> {
  const c = (g.__hirakumiAnyApiSchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const rows = await sql`
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'apis' and column_name = 'intake_kind'`;
      c.ready = rows.length > 0;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/** For routes that need migration 0014: a 503 while it has not run, else null. */
export async function updatingResponse(sql: Sql): Promise<Response | null> {
  return (await hasAnyApiSchema(sql)) ? null : errorJson(503, UPDATING);
}

/** True when sellers may list an API from example requests: SAMPLES_INTAKE is on and migration 0014 has run. */
export async function samplesIntakeOpen(sql: Sql): Promise<boolean> {
  return env.samplesIntake() && (await hasAnyApiSchema(sql));
}

/** Tests only: forget the result, so the next call checks the database again. */
export function resetSchemaCheck(): void {
  g.__hirakumiAnyApiSchema = undefined;
}
