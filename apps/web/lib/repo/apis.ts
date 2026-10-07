import type postgres from "postgres";
import {
  compareBases, judgeListingBase, LISTED_BY_OTHER, listActiveOnOrigin, newId, overlapWarning, takenEarly, type QueryFn,
} from "@hirakumi/core";
import type { Sql } from "../db";
import { recordsKeptReason } from "../api-delete";
import type { Api, ApiState, OnboardStep } from "../types";
import { API_DELETE_ORDER, registerStartedSql, soldSql } from "./delete-api";
import { hasAnyApiSchema } from "./schema";

export const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "path_prefix", "openapi_url", "intake_kind", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];
/** Before migration 0014 there is no intake_kind: every API then came from an OpenAPI link (lib/repo/schema.ts). */
const LEGACY_API_COLUMNS = API_COLUMNS.filter((c) => c !== "intake_kind");

/**
 * The select list for an Api row, on either side of migration 0014 (anyApi: hasAnyApiSchema). Synchronous on
 * purpose: a fragment is a thenable, so returning it from an async function would run it as a query.
 */
export function apiColumns(sql: Sql | postgres.TransactionSql, anyApi: boolean) {
  return anyApi ? sql`${sql(API_COLUMNS)}` : sql`${sql(LEGACY_API_COLUMNS)}, 'openapi'::text as intake_kind`;
}

/**
 * What the seller gave: an OpenAPI link (hosted anywhere; openapiUrl set, origin is the link's and only a
 * placeholder until the parse step sets it from servers[0]), or (any API) a base URL and example requests
 * (openapiUrl null, origin from the base, which is final).
 */
export type ApiInput =
  | { sellerId: string; name: string; origin: string; openapiUrl: string; samples?: undefined }
  | { sellerId: string; name: string; origin: string; openapiUrl: null; samples: { base: string; lines: string } };

/** The samples as a jsonb parameter (an object, not a JSON string), or null for an OpenAPI link. */
const samplesOf = (tx: postgres.TransactionSql, input: ApiInput) => (input.samples ? tx.json(input.samples as postgres.JSONValue) : null);

export async function createApi(
  sql: Sql,
  input: ApiInput,
): Promise<{ api: Api; created: boolean } | { takenByOther: true }> {
  return sql.begin(async (tx) => {
    // Serialise double submits of the same link (or the same samples base) by the same seller.
    await tx`select pg_advisory_xact_lock(hashtext(${`${input.sellerId}|${intakeKey(input)}`}))`;
    const anyApi = await hasAnyApiSchema(tx);
    const cols = apiColumns(tx, anyApi);
    // Audit I1: an API whose onboarding failed for good is not "the same API" any more: pasting the link
    // again (after fixing the API) must start over, or the seller is stuck on the failure forever.
    const [existing] = await tx<Api[]>`
      select ${cols} from apis
      where seller_id = ${input.sellerId} and state <> 'retired' and ${sameIntake(tx, input, anyApi)}
        and not exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed')
      order by created_at desc limit 1`;
    if (existing) return { api: existing, created: false };
    if (await isTakenEarly(tx, input)) return { takenByOther: true as const };
    if (input.samples) await eraseEarlierSamples(tx, input.sellerId, input.samples.base);
    const [api] = anyApi
      ? await tx<Api[]>`
        insert into apis (id, seller_id, name, origin, openapi_url, intake_kind, samples)
        values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl},
                ${input.samples ? "samples" : "openapi"}, ${samplesOf(tx, input)})
        returning ${cols}`
      : await tx<Api[]>`
        insert into apis (id, seller_id, name, origin, openapi_url)
        values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl})
        returning ${cols}`;
    return { api, created: true };
  });
}

/** What makes two submits "the same API": the OpenAPI link, or the samples base (samples APIs have no link). */
const intakeKey = (input: ApiInput) => (input.samples ? `samples|${input.samples.base}` : `openapi|${input.openapiUrl}`);

/** Before migration 0014 (anyApi false) every API came from a link; callers refuse samples then (lib/repo/schema.ts). */
const sameIntake = (tx: postgres.TransactionSql, input: ApiInput, anyApi: boolean) => (!anyApi
  ? tx`openapi_url = ${input.openapiUrl}`
  : input.samples
    ? tx`intake_kind = 'samples' and samples = ${samplesOf(tx, input)}::jsonb`
    : tx`intake_kind = 'openapi' and openapi_url = ${input.openapiUrl} and samples is null`);

/**
 * Corrected example requests for the same base URL replace the earlier ones: the earlier API is erased while
 * nothing about it was chosen yet (before the endpoints are confirmed), so the seller doesn't end up with two APIs
 * on one base, of which only one can be listed. Same rule as with an OpenAPI link, where resubmitting returns the
 * one API. An API on a Sokosumi task is left alone: the task tracks it.
 */
async function eraseEarlierSamples(tx: postgres.TransactionSql, sellerId: string, base: string): Promise<void> {
  const earlier = await tx<{ id: string }[]>`
    select id from apis
    where seller_id = ${sellerId} and intake_kind = 'samples' and samples->>'base' = ${base}
      and state in ('intake', 'parsed', 'described') and sokosumi_task_id is null and deleted_at is null
    for update`;
  for (const { id } of earlier) {
    for (const step of API_DELETE_ORDER) await step.run(tx, id);
    await tx`delete from apis where id = ${id}`;
  }
}

/** Runs $n-parameter SQL on postgres.js, for the checks shared with the coworker (@hirakumi/core listingBase). */
export const queryOn = (sql: Sql | postgres.TransactionSql): QueryFn =>
  (text, params) => sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);

/**
 * Early, advisory: another account already lists this base (one API, one listing). Only for example requests,
 * whose base the seller just gave. An OpenAPI link says nothing about the base any more (the file may be hosted
 * anywhere; servers[0] decides), so the parse step and the check at proof of ownership (finalizeOwnership) decide.
 */
async function isTakenEarly(sql: Sql | postgres.TransactionSql, input: ApiInput): Promise<boolean> {
  if (!input.samples) return false;
  const pathPrefix = new URL(input.samples.base).pathname;
  return takenEarly({ sellerId: input.sellerId, origin: input.origin, pathPrefix }, await listActiveOnOrigin(queryOn(sql), input.origin));
}

/**
 * What the ownership and review steps say about this API's base, computed on read: `blocked` when the proof
 * would be refused, and a warning per overlapping listing of the same seller. Empty before the base is known.
 */
export async function listingBaseNotes(sql: Sql, apiId: string): Promise<{ blocked: string | null; warnings: string[] }> {
  const [me] = await sql<{ sellerId: string; origin: string; pathPrefix: string; state: ApiState }[]>`
    select seller_id, origin, path_prefix, state from apis where id = ${apiId}`;
  if (!me || me.state === "intake" || me.state === "retired") return { blocked: null, warnings: [] };
  const others = await listActiveOnOrigin(queryOn(sql), me.origin, apiId);
  const verdict = judgeListingBase(me, others);
  const warnings = others
    .filter((o) => o.sellerId === me.sellerId && compareBases(me, o) === "overlap")
    .map((o) => overlapWarning(o.name));
  return { blocked: verdict.ok ? null : verdict.message, warnings };
}

export { LISTED_BY_OTHER };

/** A Sokosumi coworker task, found by the setup link the coworker posted on it (review I5). */
export async function findCoworkerTask(sql: Sql, setupToken: string): Promise<{ taskId: string; sokosumiUserId: string } | null> {
  const [row] = await sql<{ taskId: string; sokosumiUserId: string }[]>`
    select task_id, sokosumi_user_id from coworker_tasks where setup_token = ${setupToken}`;
  return row ?? null;
}

/** Serialises every change of which wallet holds a Sokosumi account (lib/repo/sokosumi-link.ts). */
export const sokosumiLock = (tx: postgres.TransactionSql, sokosumiUserId: string) =>
  tx`select pg_advisory_xact_lock(hashtext(${`sokosumi|${sokosumiUserId}`}))`;

/** Create the API from a setup link: one API per Sokosumi task, linked so progress and billing reach the task. */
export async function createApiForTask(
  sql: Sql,
  input: ApiInput,
  task: { taskId: string; sokosumiUserId: string },
): Promise<{ api: Api; created: boolean } | { claimedByOther: true } | { linkedElsewhere: true } | { takenByOther: true }> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`task|${task.taskId}`}))`;
    // Audit M4: the first wallet to use a setup link owns that task; progress and billing go to it.
    const [other] = await tx`select 1 from apis where sokosumi_task_id = ${task.taskId} and seller_id <> ${input.sellerId} limit 1`;
    if (other) return { claimedByOther: true as const };
    // A Sokosumi account belongs to one wallet; moving it is its own explicit step (POST /api/sokosumi/link).
    await sokosumiLock(tx, task.sokosumiUserId);
    const [elsewhere] = await tx`
      select 1 from sellers where sokosumi_user_id = ${task.sokosumiUserId} and id <> ${input.sellerId} limit 1`;
    if (elsewhere) return { linkedElsewhere: true as const };
    // The setup page tells the seller this submit links their Sokosumi account to this wallet.
    await tx`update sellers set sokosumi_user_id = ${task.sokosumiUserId} where id = ${input.sellerId} and sokosumi_user_id is null`;
    const anyApi = await hasAnyApiSchema(tx);
    const cols = apiColumns(tx, anyApi);
    const [linked] = await tx<Api[]>`
      select ${cols} from apis where sokosumi_task_id = ${task.taskId} and seller_id = ${input.sellerId} and state <> 'retired'
        and not exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed')
      order by created_at desc limit 1`;
    if (linked) return { api: linked, created: false };
    if (await isTakenEarly(tx, input)) return { takenByOther: true as const };
    const [api] = anyApi
      ? await tx<Api[]>`
        insert into apis (id, seller_id, name, origin, openapi_url, intake_kind, samples, sokosumi_task_id)
        values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl},
                ${input.samples ? "samples" : "openapi"}, ${samplesOf(tx, input)}, ${task.taskId})
        returning ${cols}`
      : await tx<Api[]>`
        insert into apis (id, seller_id, name, origin, openapi_url, sokosumi_task_id)
        values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl}, ${task.taskId})
        returning ${cols}`;
    return { api, created: true };
  });
}

export async function getApiForSeller(sql: Sql, apiId: string, sellerId: string): Promise<Api | null> {
  // Postgres text can't hold a NUL byte, so no row has such an id; asking would fail the query (a 500).
  if (apiId.includes("\u0000")) return null;
  const [row] = await sql<Api[]>`select ${apiColumns(sql, await hasAnyApiSchema(sql))} from apis where id = ${apiId} and seller_id = ${sellerId} and deleted_at is null`;
  return row ?? null;
}

export async function getLiveApi(sql: Sql, apiId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${apiColumns(sql, await hasAnyApiSchema(sql))} from apis where id = ${apiId} and state = 'live'`;
  return row ?? null;
}

/** The seller's APIs whose onboarding stopped at a failed step (shown as "Stopped"). */
export async function listStoppedApiIds(sql: Sql, sellerId: string): Promise<Set<string>> {
  const rows = await sql<{ apiId: string }[]>`
    select distinct s.api_id from onboard_steps s join apis a on a.id = s.api_id
    where a.seller_id = ${sellerId} and a.deleted_at is null and s.status = 'failed'`;
  return new Set(rows.map((r) => r.apiId));
}

/** For each of the seller's APIs, why deleting it keeps its records (null: it would be erased). */
export async function listRecordsKept(sql: Sql, sellerId: string): Promise<Map<string, string | null>> {
  const a = sql`a.id`;
  const rows = await sql<{ id: string; state: ApiState; agentIdentifier: string | null; registerStarted: boolean; sold: boolean }[]>`
    select a.id, a.state, a.agent_identifier, ${registerStartedSql(sql, a)} as register_started, ${soldSql(sql, a)} as sold
    from apis a where a.seller_id = ${sellerId} and a.deleted_at is null`;
  return new Map(rows.map((r) => [r.id, recordsKeptReason(r)]));
}

export async function listApisForSeller(sql: Sql, sellerId: string): Promise<Api[]> {
  return sql<Api[]>`select ${apiColumns(sql, await hasAnyApiSchema(sql))} from apis where seller_id = ${sellerId} and deleted_at is null order by created_at desc`;
}

/** Conditional transition: succeeds only from one of `from`, so double clicks and races can't skip a step. */
export async function transitionState(
  sql: Sql,
  a: { apiId: string; sellerId: string; from: ApiState[]; to: ApiState },
): Promise<boolean> {
  const rows = await sql`
    update apis set state = ${a.to}
    where id = ${a.apiId} and seller_id = ${a.sellerId} and state in ${sql(a.from)}
    returning id`;
  return rows.length === 1;
}

/**
 * The coworker's onboarding steps for one API. onboard_steps also holds data rows that are not steps
 * (seller_samples); only the coworker's real step names are returned.
 */
export const ONBOARD_STEP_NAMES = ["parse", "describe", "qa", "register"] as const;

export async function listOnboardSteps(sql: Sql, apiId: string): Promise<OnboardStep[]> {
  return sql<OnboardStep[]>`
    select step, status, output, updated_at from onboard_steps
    where api_id = ${apiId} and step in ${sql(ONBOARD_STEP_NAMES)}
    order by updated_at asc`;
}
