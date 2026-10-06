import type postgres from "postgres";
import {
  compareBases, judgeListingBase, LISTED_BY_OTHER, listActiveOnOrigin, newId, overlapWarning, takenEarly, type QueryFn,
} from "@hirakumi/core";
import type { Sql } from "../db";
import { recordsKeptReason } from "../api-delete";
import type { Api, ApiState, OnboardStep } from "../types";
import { registerStartedSql, soldSql } from "./delete-api";

export const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "openapi_url", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];

export async function createApi(
  sql: Sql,
  input: { sellerId: string; name: string; origin: string; openapiUrl: string },
): Promise<{ api: Api; created: boolean } | { takenByOther: true }> {
  return sql.begin(async (tx) => {
    // Serialise double submits of the same link by the same seller.
    await tx`select pg_advisory_xact_lock(hashtext(${`${input.sellerId}|${input.openapiUrl}`}))`;
    // Audit I1: an API whose onboarding failed for good is not "the same API" any more: pasting the link
    // again (after fixing the API) must start over, or the seller is stuck on the failure forever.
    const [existing] = await tx<Api[]>`
      select ${tx(API_COLUMNS)} from apis
      where seller_id = ${input.sellerId} and openapi_url = ${input.openapiUrl} and state <> 'retired'
        and not exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed')
      order by created_at desc limit 1`;
    if (existing) return { api: existing, created: false };
    if (await isTakenEarly(tx, input)) return { takenByOther: true as const };
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl})
      returning ${tx(API_COLUMNS)}`;
    return { api, created: true };
  });
}

/** Runs $n-parameter SQL on postgres.js, for the checks shared with the coworker (@hirakumi/core listingBase). */
export const queryOn = (sql: Sql | postgres.TransactionSql): QueryFn =>
  (text, params) => sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);

/**
 * Early, advisory: another account already lists a base this link can only lead to (one API, one listing).
 * The check at proof of ownership (finalizeOwnership) is the authority.
 */
async function isTakenEarly(sql: Sql | postgres.TransactionSql, input: { sellerId: string; origin: string; openapiUrl: string }): Promise<boolean> {
  return takenEarly(input, await listActiveOnOrigin(queryOn(sql), input.origin));
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

/** Create the API from a setup link: one API per Sokosumi task, linked so progress and billing reach the task. */
export async function createApiForTask(
  sql: Sql,
  input: { sellerId: string; name: string; origin: string; openapiUrl: string },
  task: { taskId: string; sokosumiUserId: string },
): Promise<{ api: Api; created: boolean } | { claimedByOther: true } | { takenByOther: true }> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`task|${task.taskId}`}))`;
    // Audit M4: the first wallet to use a setup link owns that task; progress and billing go to it.
    const [other] = await tx`select 1 from apis where sokosumi_task_id = ${task.taskId} and seller_id <> ${input.sellerId} limit 1`;
    if (other) return { claimedByOther: true as const };
    await tx`update sellers set sokosumi_user_id = ${task.sokosumiUserId} where id = ${input.sellerId} and sokosumi_user_id is null`;
    const [linked] = await tx<Api[]>`
      select ${tx(API_COLUMNS)} from apis where sokosumi_task_id = ${task.taskId} and seller_id = ${input.sellerId} and state <> 'retired'
        and not exists (select 1 from onboard_steps s where s.api_id = apis.id and s.status = 'failed')
      order by created_at desc limit 1`;
    if (linked) return { api: linked, created: false };
    if (await isTakenEarly(tx, input)) return { takenByOther: true as const };
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url, sokosumi_task_id)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl}, ${task.taskId})
      returning ${tx(API_COLUMNS)}`;
    return { api, created: true };
  });
}

export async function getApiForSeller(sql: Sql, apiId: string, sellerId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and seller_id = ${sellerId} and deleted_at is null`;
  return row ?? null;
}

export async function getLiveApi(sql: Sql, apiId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and state = 'live'`;
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
  return sql<Api[]>`select ${sql(API_COLUMNS)} from apis where seller_id = ${sellerId} and deleted_at is null order by created_at desc`;
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
