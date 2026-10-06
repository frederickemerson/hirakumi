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
    const [existing] = await tx<Api[]>`
      select ${tx(API_COLUMNS)} from apis
      where seller_id = ${input.sellerId} and openapi_url = ${input.openapiUrl} and state <> 'retired'
      order by created_at desc limit 1`;
    if (existing) return { api: existing, created: false };
    const [api] = await tx<Api[]>`
      insert into apis (id, seller_id, name, origin, openapi_url)
      values (${newId("api")}, ${input.sellerId}, ${input.name}, ${input.origin}, ${input.openapiUrl})
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

export async function listOnboardSteps(sql: Sql, apiId: string): Promise<OnboardStep[]> {
  return sql<OnboardStep[]>`
    select step, status, output, updated_at from onboard_steps where api_id = ${apiId} order by updated_at asc`;
}
