import { newId } from "@hirakumi/core";
import type { Sql } from "../db";
import type { Api, ApiState, OnboardStep } from "../types";

export const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "openapi_url", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];

export async function createApi(
  sql: Sql,
  input: { sellerId: string; name: string; origin: string; openapiUrl: string },
): Promise<{ api: Api; created: boolean }> {
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
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl})
      returning ${tx(API_COLUMNS)}`;
    return { api, created: true };
  });
}

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
): Promise<{ api: Api; created: boolean } | { claimedByOther: true }> {
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
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url, sokosumi_task_id)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl}, ${task.taskId})
      returning ${tx(API_COLUMNS)}`;
    return { api, created: true };
  });
}

export async function getApiForSeller(sql: Sql, apiId: string, sellerId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and seller_id = ${sellerId}`;
  return row ?? null;
}

export async function getLiveApi(sql: Sql, apiId: string): Promise<Api | null> {
  const [row] = await sql<Api[]>`select ${sql(API_COLUMNS)} from apis where id = ${apiId} and state = 'live'`;
  return row ?? null;
}

export async function listApisForSeller(sql: Sql, sellerId: string): Promise<Api[]> {
  return sql<Api[]>`select ${sql(API_COLUMNS)} from apis where seller_id = ${sellerId} order by created_at desc`;
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
