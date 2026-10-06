import { sha256Hex } from "@hirakumi/core";
import type { Sql } from "./db";

export type TryOperationRow = {
  opId: string;
  method: string;
  path: string;
  description: string | null;
  inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
};

/** Enabled endpoints of a live API with their input schemas, for the public try page. */
export async function listTryOperations(sql: Sql, apiId: string): Promise<TryOperationRow[]> {
  return sql<TryOperationRow[]>`
    select o.op_id, o.method, o.path, o.description, o.input_schema
    from operations o join apis a on a.id = o.api_id
    where o.api_id = ${apiId} and o.enabled and a.state = 'live'
    order by o.path, o.method`;
}

/** Credits left on the demo pack token, or null when the token is unknown, pending, exhausted or revoked. */
export async function demoCreditsLeft(sql: Sql, token: string): Promise<number | null> {
  const [row] = await sql<{ remaining: number; status: string }[]>`
    select remaining, status from credit_tokens where token_hash = ${sha256Hex(token)}`;
  return row && row.status === "active" && row.remaining > 0 ? row.remaining : null;
}

/**
 * Why a paid try can't run now, or null when it can. Counted from the gateway's own call log for the demo
 * token, so the cap holds across every serverless instance (a per-instance memory limit can't).
 */
export async function demoBudgetProblem(sql: Sql, token: string, perHour: number): Promise<string | null> {
  const [row] = await sql<{ id: string; remaining: number; status: string; used: number }[]>`
    select t.id, t.remaining, t.status,
           (select count(*)::int from calls c where c.credit_token_id = t.id and c.created_at > now() - interval '1 hour') as used
    from credit_tokens t where t.token_hash = ${sha256Hex(token)}`;
  if (!row || row.status !== "active" || row.remaining <= 0) return "The demo credits are used up. You can still see the payment offer an agent gets.";
  if (row.used >= perHour) return "The demo has used its paid tries for this hour. Try again later, or see the payment offer an agent gets.";
  return null;
}
