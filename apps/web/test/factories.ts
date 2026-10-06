import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { newId, ruleHash, type RuleDefinition } from "@hirakumi/core";
import { getSql } from "@/lib/db";
import type { Api, ApiState, Health, OnboardStepStatus, Operation, Pack, Seller } from "@/lib/types";

const API_COLUMNS = [
  "id", "seller_id", "name", "origin", "openapi_url", "state", "health",
  "health_checked_at", "escrow_op_id", "agent_identifier", "created_at",
];

export const TEST_RULE: RuleDefinition = {
  version: 1,
  status: { min: 200, max: 299 },
  contentType: "application/json",
  schema: {
    type: "object",
    required: ["price", "last_updated"],
    properties: { price: { type: "number" }, last_updated: { type: "string", maxAgeSeconds: 300 } },
  },
};

export async function seedSeller(cardanoAddr = `addr_test1seed${randomBytes(8).toString("hex")}`): Promise<Seller> {
  const sql = getSql();
  const [row] = await sql<Seller[]>`
    insert into sellers (id, cardano_addr) values (${newId("sel")}, ${cardanoAddr})
    returning id, cardano_addr`;
  return row;
}

export async function seedApi(
  sellerId: string,
  state: ApiState = "intake",
  over: Partial<{ name: string; origin: string; openapiUrl: string; escrowOpId: string | null;
    agentIdentifier: string | null; health: Health; healthCheckedAt: Date | null }> = {},
): Promise<Api> {
  const sql = getSql();
  const [row] = await sql<Api[]>`
    insert into apis (id, seller_id, name, origin, openapi_url, state, health, health_checked_at, escrow_op_id, agent_identifier)
    values (${newId("api")}, ${sellerId}, ${over.name ?? "Price API"}, ${over.origin ?? "https://price.example.dev"},
            ${over.openapiUrl ?? "https://price.example.dev/openapi.json"}, ${state}, ${over.health ?? "healthy"},
            ${over.healthCheckedAt ?? null}, ${over.escrowOpId ?? null}, ${over.agentIdentifier ?? null})
    returning ${sql(API_COLUMNS)}`;
  return row;
}

export async function seedOperation(
  apiId: string,
  over: Partial<Omit<Operation, "id">> = {},
): Promise<Operation> {
  const sql = getSql();
  const [row] = await sql<Operation[]>`
    insert into operations (id, api_id, op_id, method, path, input_schema, description, side_effects_likely,
                            side_effects_confirmed_none, enabled)
    values (${newId("op")}, ${apiId}, ${over.opId ?? "getPrice"}, ${over.method ?? "GET"}, ${over.path ?? "/price"},
            '{}'::jsonb, ${over.description ?? "Latest price for a symbol"}, ${over.sideEffectsLikely ?? false},
            ${over.sideEffectsConfirmedNone ?? false}, ${over.enabled ?? false})
    returning id, op_id, method, path, description, side_effects_likely, side_effects_confirmed_none, enabled`;
  return row;
}

export async function seedRule(
  operationId: string,
  over: Partial<{ definition: RuleDefinition; plainEnglish: string | null; version: number }> = {},
): Promise<{ id: string; hash: string }> {
  const sql = getSql();
  const definition: RuleDefinition = over.definition ?? {
    ...TEST_RULE,
    schema: { ...TEST_RULE.schema, title: operationId }, // distinct hash per operation (contract note A7)
  };
  const [row] = await sql<{ id: string; hash: string }[]>`
    insert into rules (id, operation_id, version, definition, hash, plain_english)
    values (${newId("rule")}, ${operationId}, ${over.version ?? 1}, ${sql.json(definition as unknown as postgres.JSONValue)},
            ${ruleHash(definition)},
            ${over.plainEnglish === undefined ? 'The response has a number "price" and a "last_updated" time under 5 minutes old.' : over.plainEnglish})
    returning id, hash`;
  return row;
}

export async function seedPack(
  apiId: string,
  over: Partial<{ calls: number; priceMicros: string; escrowPriceMicros: string }> = {},
): Promise<Pack> {
  const sql = getSql();
  const [row] = await sql<Pack[]>`
    insert into packs (id, api_id, calls, price_micros, escrow_price_micros)
    values (${newId("pk")}, ${apiId}, ${over.calls ?? 100}, ${over.priceMicros ?? "2000000"}::bigint,
            ${over.escrowPriceMicros ?? "2000000"}::bigint)
    returning id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros`;
  return row;
}

export async function seedOnboardStep(
  apiId: string,
  step: string,
  status: OnboardStepStatus,
  output: unknown = null,
): Promise<void> {
  await getSql()`
    insert into onboard_steps (api_id, step, status, attempts, output)
    values (${apiId}, ${step}, ${status}, 1, ${output === null ? null : getSql().json(output as postgres.JSONValue)})`;
}
