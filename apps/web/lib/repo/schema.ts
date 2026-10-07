import type postgres from "postgres";
import type { Sql } from "../db";
import { env } from "../env";
import { errorJson } from "../http";

/**
 * Deploy order: the web may start before migrations 0014 (example requests, sellers' keys) and 0015 (the
 * X-Hirakumi-Verify proof, samples APIs without an OpenAPI link) have run. Until both have, the web reads apis without intake_kind, samples and upstream_auth, hides the key
 * form and the example requests option, and the routes that need those columns (or challenges of kind 'header')
 * answer 503 with UPDATING instead of failing.
 *
 * Checked once per process. A missing column is checked again every RECHECK_MS, so the web picks the migration
 * up without a restart; once present it is never checked again (migrations only add).
 */
export const UPDATING = "This part of Hirakumi is being updated. Try again in a few minutes.";

const RECHECK_MS = 60_000;

type Check = { ready: boolean; at: number; pending: Promise<boolean> | null };
const g = globalThis as unknown as { __hirakumiAnyApiSchema?: Check; __hirakumiDnsVerifySchema?: Check; __hirakumiExposureSchema?: Check; __hirakumiFrontDoorSchema?: Check };

/**
 * True once migrations 0014 and 0015 have run: apis.intake_kind exists (0014) and so does the index that keeps one
 * open 'header' code per API (0015). A database may have 0014 without 0015 (0014 shipped on its own first).
 */
export async function hasAnyApiSchema(sql: Sql | postgres.TransactionSql): Promise<boolean> {
  const c = (g.__hirakumiAnyApiSchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const [row] = await sql<{ ready: boolean }[]>`
        select exists (
                 select 1 from information_schema.columns
                 where table_schema = current_schema() and table_name = 'apis' and column_name = 'intake_kind')
               and exists (
                 select 1 from pg_indexes
                 where schemaname = current_schema() and indexname = 'challenges_header_open_per_api') as ready`;
      c.ready = row?.ready === true;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/**
 * True once migration 0018 has run too: the index that keeps one open 'dns' code per API. The ownership page and
 * routes need it (the code is a challenge of kind 'dns'). Cached the same way as hasAnyApiSchema.
 */
export async function hasDnsVerifySchema(sql: Sql): Promise<boolean> {
  if (!(await hasAnyApiSchema(sql))) return false;
  const c = (g.__hirakumiDnsVerifySchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const [row] = await sql<{ ready: boolean }[]>`
        select exists (
          select 1 from pg_indexes
          where schemaname = current_schema() and indexname = 'challenges_dns_open_per_api') as ready`;
      c.ready = row?.ready === true;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/**
 * True once migration 0019 has run: apis.exposure exists, where the leak check stores its result. Before that the
 * publish gate still runs the check (it never relies on a stored result); only storing and showing it wait.
 * Cached the same way as hasAnyApiSchema.
 */
export async function hasExposureSchema(sql: Sql): Promise<boolean> {
  const c = (g.__hirakumiExposureSchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const [row] = await sql<{ ready: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'apis' and column_name = 'exposure_checked_at') as ready`;
      c.ready = row?.ready === true;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/**
 * True once migration 0020 has run: apis.public_host and api_domains (the front door). Before it, the protect page
 * hides the front door and retire and delete have no domain to detach. Cached the same way as hasAnyApiSchema.
 */
export async function hasFrontDoorSchema(sql: Sql | postgres.TransactionSql): Promise<boolean> {
  const c = (g.__hirakumiFrontDoorSchema ??= { ready: false, at: 0, pending: null });
  if (c.ready || (c.at && Date.now() - c.at < RECHECK_MS)) return c.ready;
  c.pending ??= (async () => {
    try {
      const [row] = await sql<{ ready: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'apis' and column_name = 'public_host') as ready`;
      c.ready = row?.ready === true;
      c.at = Date.now();
      return c.ready;
    } finally {
      c.pending = null;
    }
  })();
  return c.pending;
}

/** For the front-door routes: a 503 until migration 0020 has run, else null. */
export async function frontDoorUpdatingResponse(sql: Sql): Promise<Response | null> {
  return (await hasFrontDoorSchema(sql)) ? null : errorJson(503, UPDATING);
}

/** For the ownership routes: a 503 until migrations 0014, 0015 and 0018 have run, else null. */
export async function ownershipUpdatingResponse(sql: Sql): Promise<Response | null> {
  return (await hasDnsVerifySchema(sql)) ? null : errorJson(503, UPDATING);
}

/** For routes that need migrations 0014 and 0015: a 503 while it has not run, else null. */
export async function updatingResponse(sql: Sql): Promise<Response | null> {
  return (await hasAnyApiSchema(sql)) ? null : errorJson(503, UPDATING);
}

/** True when sellers may list an API from example requests: SAMPLES_INTAKE is on and migrations 0014 and 0015 have run. */
export async function samplesIntakeOpen(sql: Sql): Promise<boolean> {
  return env.samplesIntake() && (await hasAnyApiSchema(sql));
}

/** Tests only: forget the result, so the next call checks the database again. */
export function resetSchemaCheck(): void {
  g.__hirakumiAnyApiSchema = undefined;
  g.__hirakumiDnsVerifySchema = undefined;
  g.__hirakumiExposureSchema = undefined;
  g.__hirakumiFrontDoorSchema = undefined;
}
