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
export async function seedCreditToken(
  apiId: string,
  packId: string,
  over: Partial<{ status: "pending" | "active" | "exhausted" | "revoked"; remaining: number; payer: string | null;
    txHash: string | null; createdAt: Date }> = {},
): Promise<{ id: string }> {
  const [row] = await getSql()<{ id: string }[]>`
    insert into credit_tokens (id, api_id, pack_id, token_hash, payer, status, remaining, payment_payload_hash, tx_hash, created_at)
    values (${newId("ct")}, ${apiId}, ${packId}, ${randomBytes(32).toString("hex")}, ${over.payer ?? "addr_test1buyer"},
            ${over.status ?? "active"}, ${over.remaining ?? 100}, ${randomBytes(32).toString("hex")},
            ${over.txHash === undefined ? randomBytes(32).toString("hex") : over.txHash}, ${over.createdAt ?? new Date()})
    returning id`;
  return row;
}

export async function seedCall(
  apiId: string,
  over: Partial<{ kind: "credit" | "escrow" | "probe" | "preview"; verdict: "pass" | "fail" | "n/a";
    execution: "upstream_ok" | "upstream_error" | "timeout" | "blocked"; createdAt: Date }> = {},
): Promise<void> {
  await getSql()`
    insert into calls (id, kind, api_id, op_id, execution, verdict, created_at)
    values (${newId("call")}, ${over.kind ?? "credit"}, ${apiId}, 'getPrice', ${over.execution ?? "upstream_ok"},
            ${over.verdict ?? "pass"}, ${over.createdAt ?? new Date()})`;
}

export async function seedJob(
  apiId: string,
  over: Partial<{ status: "awaiting_payment" | "running" | "completed" | "failed" | "expired"; failureReasons: string[] | null;
    createdAt: Date }> = {},
): Promise<{ id: string }> {
  const [row] = await getSql()<{ id: string }[]>`
    insert into jobs (id, api_id, identifier_from_purchaser, input, input_hash, status, failure_reasons, created_at)
    values (${newId("job")}, ${apiId}, 'buyer-ref-1', '{}'::jsonb, 'hash', ${over.status ?? "completed"},
            ${over.failureReasons == null ? null : getSql().json(over.failureReasons as postgres.JSONValue)}, ${over.createdAt ?? new Date()})
    returning id`;
  return row;
}

export async function seedHealthEvent(apiId: string, from: Health, to: Health, at: Date, reasons: string[] = []): Promise<void> {
  await getSql()`
    insert into health_events (api_id, from_health, to_health, reasons, at)
    values (${apiId}, ${from}, ${to}, ${getSql().json(reasons as postgres.JSONValue)}, ${at})`;
}
