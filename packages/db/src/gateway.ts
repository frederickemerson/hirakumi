import type postgres from "postgres";
import { newId, type RuleDefinition } from "@hirakumi/core";
import type { Sql } from "./client";

const json = (sql: Sql, v: unknown) => sql.json(v as postgres.JSONValue);

export type ApiState =
  | "intake" | "parsed" | "described" | "endpoints_confirmed" | "ownership_verified"
  | "rule_built" | "priced" | "registering" | "live" | "retired";
export type Health = "healthy" | "down";
export type ApiRow = {
  id: string; seller_id: string; name: string; origin: string; path_prefix: string; state: ApiState;
  health: Health; health_checked_at: Date | null; escrow_op_id: string | null; agent_identifier: string | null;
  pay_to: string;
};
export type OperationRow = {
  id: string; api_id: string; op_id: string; method: string; path: string;
  input_schema: Record<string, unknown>; description: string | null; enabled: boolean;
};
export type RuleRow = { id: string; operation_id: string; version: number; definition: RuleDefinition; hash: string; plain_english: string | null };
export type PackRow = { id: string; api_id: string; calls: number; price_micros: string; escrow_price_micros: string };
export type ApiBundle = { api: ApiRow; operations: OperationRow[]; rules: RuleRow[]; packs: PackRow[] };

export async function loadApiBundle(sql: Sql, apiId: string): Promise<ApiBundle | null> {
  const [api] = await sql<ApiRow[]>`
    select a.id, a.seller_id, a.name, a.origin, a.path_prefix, a.state, a.health, a.health_checked_at,
           a.escrow_op_id, a.agent_identifier, s.cardano_addr as pay_to
    from apis a join sellers s on s.id = a.seller_id
    where a.id = ${apiId}`;
  if (!api) return null;
  const operations = await sql<OperationRow[]>`
    select id, api_id, op_id, method, path, input_schema, description, enabled
    from operations where api_id = ${apiId} order by op_id`;
  const rules = await sql<RuleRow[]>`
    select distinct on (r.operation_id) r.id, r.operation_id, r.version, r.definition, r.hash, r.plain_english
    from rules r join operations o on o.id = r.operation_id
    where o.api_id = ${apiId}
    order by r.operation_id, r.version desc`;
  const packs = await sql<PackRow[]>`
    select id, api_id, calls, price_micros::text as price_micros, escrow_price_micros::text as escrow_price_micros
    from packs where api_id = ${apiId} order by price_micros, id`;
  return { api, operations, rules, packs };
}

// ---------------------------------------------------------------- credit tokens

export type CreditStatus = "pending" | "active" | "exhausted" | "revoked";

export async function insertPendingToken(
  sql: Sql,
  t: {
    id: string; apiId: string; packId: string; tokenHash: string; remaining: number; paymentPayloadHash: string;
    /** The Cardano transaction this payment is: one transaction buys at most one pack. */
    txHash: string;
    /** sha256 of a secret only the buyer holds; without it the pack can never be recovered. */
    recoveryHash: string | null;
  },
): Promise<{ inserted: true; id: string } | { inserted: false; id: string; status: CreditStatus }> {
  const rows = await sql<{ id: string }[]>`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash, tx_hash, recovery_hash)
    values (${t.id}, ${t.apiId}, ${t.packId}, ${t.tokenHash}, 'pending', ${t.remaining}, ${t.paymentPayloadHash}, ${t.txHash}, ${t.recoveryHash})
    on conflict do nothing
    returning id`;
  if (rows.length) return { inserted: true, id: rows[0].id };
  const [existing] = await sql<{ id: string; status: CreditStatus }[]>`
    select id, status from credit_tokens
    where payment_payload_hash = ${t.paymentPayloadHash} or (tx_hash = ${t.txHash} and status <> 'revoked')
    order by created_at limit 1`;
  return { inserted: false, id: existing.id, status: existing.status };
}

export type RecoveryRow = { id: string; status: CreditStatus; remaining: number; recoveryHash: string | null };

/** The live token bought by this Cardano transaction for this API, if any. */
export async function findTokenByTx(sql: Sql, apiId: string, txHash: string): Promise<RecoveryRow | null> {
  const [row] = await sql<{ id: string; status: CreditStatus; remaining: number; recovery_hash: string | null }[]>`
    select id, status, remaining, recovery_hash from credit_tokens
    where tx_hash = ${txHash} and api_id = ${apiId} and status <> 'revoked'`;
  return row ? { id: row.id, status: row.status, remaining: row.remaining, recoveryHash: row.recovery_hash } : null;
}

/** Pack recovery: re-key a token whose owner already proved the recovery secret. */
export async function rotateTokenById(sql: Sql, id: string, newTokenHash: string): Promise<{ id: string; status: CreditStatus; remaining: number } | null> {
  const [row] = await sql<{ id: string; status: CreditStatus; remaining: number }[]>`
    update credit_tokens set token_hash = ${newTokenHash} where id = ${id} and status <> 'revoked'
    returning id, status, remaining`;
  return row ?? null;
}

export async function activateTokenByPayment(sql: Sql, paymentPayloadHash: string, txHash: string | null, payer: string | null): Promise<boolean> {
  const rows = await sql`
    update credit_tokens
    set status = 'active', tx_hash = coalesce(tx_hash, ${txHash}::text), payer = coalesce(${payer}::text, payer)
    where payment_payload_hash = ${paymentPayloadHash} and status = 'pending'
    returning id`;
  return rows.length === 1;
}

/** A pending payment whose transaction can no longer land: it can never buy anything. */
export async function revokePendingToken(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update credit_tokens set status = 'revoked' where id = ${id} and status = 'pending' returning id`;
  return rows.length === 1;
}

export async function activateTokenById(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update credit_tokens set status = 'active' where id = ${id} and status = 'pending' returning id`;
  return rows.length === 1;
}

export type Reservation =
  | { ok: true; tokenId: string; remainingAfter: number }
  | { ok: false; reason: "not_found" | "pending" | "exhausted" | "revoked" };

/** One atomic conditional decrement. Concurrent callers can never take the same credit. */
export async function reserveCredit(sql: Sql, apiId: string, tokenHash: string): Promise<Reservation> {
  const [row] = await sql<{ id: string; remaining: number }[]>`
    update credit_tokens set remaining = remaining - 1
    where token_hash = ${tokenHash} and api_id = ${apiId} and status = 'active' and remaining > 0
    returning id, remaining`;
  if (row) return { ok: true, tokenId: row.id, remainingAfter: row.remaining };
  const [t] = await sql<{ status: CreditStatus }[]>`
    select status from credit_tokens where token_hash = ${tokenHash} and api_id = ${apiId}`;
  if (!t) return { ok: false, reason: "not_found" };
  if (t.status === "pending") return { ok: false, reason: "pending" };
  if (t.status === "revoked") return { ok: false, reason: "revoked" };
  return { ok: false, reason: "exhausted" };
}

/** Gives a reserved credit back. Revives a token another request already flipped to exhausted. */
export async function releaseCredit(sql: Sql, tokenId: string): Promise<void> {
  await sql`
    update credit_tokens
    set remaining = remaining + 1, status = case when status = 'exhausted' then 'active' else status end
    where id = ${tokenId}`;
}

export async function markExhaustedIfEmpty(sql: Sql, tokenId: string): Promise<void> {
  await sql`update credit_tokens set status = 'exhausted' where id = ${tokenId} and status = 'active' and remaining = 0`;
}

export type PendingPayment = { id: string; tx_hash: string; pay_to: string; price_micros: string; age_seconds: number };

export async function listPendingPayments(sql: Sql, minAgeSeconds: number): Promise<PendingPayment[]> {
  return sql<PendingPayment[]>`
    select ct.id, ct.tx_hash, s.cardano_addr as pay_to, p.price_micros::text as price_micros,
           extract(epoch from now() - ct.created_at)::int as age_seconds
    from credit_tokens ct
    join packs p on p.id = ct.pack_id
    join apis a on a.id = ct.api_id
    join sellers s on s.id = a.seller_id
    where ct.status = 'pending' and ct.tx_hash is not null
      and ct.created_at < now() - (${minAgeSeconds} * interval '1 second')
    order by ct.created_at
    limit 50`;
}

// ---------------------------------------------------------------- calls (evidence)

export type CallInsert = {
  kind: "credit" | "escrow" | "probe" | "preview";
  apiId: string; opId: string;
  execution: "upstream_ok" | "upstream_error" | "timeout" | "blocked";
  verdict: "pass" | "fail" | "n/a";
  reasons: string[];
  creditTokenId?: string | null; jobId?: string | null; blockchainId?: string | null; ruleId?: string | null;
  latencyMs?: number | null; inputHash?: string | null; outputHash?: string | null;
};

export async function insertCall(sql: Sql, c: CallInsert): Promise<string> {
  const id = newId("call");
  await sql`
    insert into calls (id, kind, credit_token_id, job_id, blockchain_id, api_id, op_id, rule_id, execution, verdict,
                       verdict_reasons, latency_ms, input_hash, output_hash)
    values (${id}, ${c.kind}, ${c.creditTokenId ?? null}, ${c.jobId ?? null}, ${c.blockchainId ?? null}, ${c.apiId}, ${c.opId},
            ${c.ruleId ?? null}, ${c.execution}, ${c.verdict}, ${json(sql, c.reasons)}, ${c.latencyMs ?? null},
            ${c.inputHash ?? null}, ${c.outputHash ?? null})`;
  return id;
}

// ---------------------------------------------------------------- jobs (MIP-003)

export type JobStatus = "awaiting_payment" | "running" | "completed" | "failed" | "expired";
export type JobRow = {
  id: string; api_id: string; identifier_from_purchaser: string; input: unknown; input_hash: string;
  blockchain_identifier: string | null; status: JobStatus; output: string | null; output_hash: string | null;
  failure_reasons: string[] | null; pay_by_time: Date | null; submit_result_time: Date | null; created_at: Date;
};
export type JobInsert = {
  id: string; apiId: string; identifierFromPurchaser: string; input: unknown; inputHash: string;
  blockchainIdentifier: string; payByTime: Date; submitResultTime: Date;
};

export async function insertJob(sql: Sql, j: JobInsert): Promise<void> {
  await sql`
    insert into jobs (id, api_id, identifier_from_purchaser, input, input_hash, blockchain_identifier, status, pay_by_time, submit_result_time)
    values (${j.id}, ${j.apiId}, ${j.identifierFromPurchaser}, ${json(sql, j.input)}, ${j.inputHash}, ${j.blockchainIdentifier},
            'awaiting_payment', ${j.payByTime}, ${j.submitResultTime})`;
}

export async function getJob(sql: Sql, apiId: string, jobId: string): Promise<JobRow | null> {
  const [row] = await sql<JobRow[]>`select * from jobs where id = ${jobId} and api_id = ${apiId}`;
  return row ?? null;
}

export async function listJobsAwaitingPayment(sql: Sql): Promise<JobRow[]> {
  return sql<JobRow[]>`select * from jobs where status = 'awaiting_payment' order by created_at limit 100`;
}

export async function listUnsubmittedPasses(sql: Sql): Promise<JobRow[]> {
  return sql<JobRow[]>`select * from jobs where status = 'running' and output_hash is not null order by created_at limit 100`;
}

export async function claimJob(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update jobs set status = 'running' where id = ${id} and status = 'awaiting_payment' returning id`;
  return rows.length === 1;
}

export async function storeJobOutput(sql: Sql, id: string, output: string, outputHash: string): Promise<void> {
  await sql`update jobs set output = ${output}, output_hash = ${outputHash} where id = ${id} and status = 'running'`;
}

export async function markJobCompleted(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set status = 'completed' where id = ${id} and status = 'running'`;
}

export async function failJob(sql: Sql, id: string, reasons: string[]): Promise<void> {
  await sql`update jobs set status = 'failed', failure_reasons = ${json(sql, reasons)} where id = ${id} and status in ('awaiting_payment', 'running')`;
}

export async function expireJob(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set status = 'expired' where id = ${id} and status = 'awaiting_payment'`;
}

/** After a crash: a job that was running without an output never reached upstream's answer; run it again. */
export async function resetInterruptedJobs(sql: Sql): Promise<number> {
  const rows = await sql`update jobs set status = 'awaiting_payment' where status = 'running' and output_hash is null returning id`;
  return rows.length;
}

// ---------------------------------------------------------------- health

export type HealthEventReason = { op: string; reason: string; since: string | null };

export async function listMonitoredApiIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from apis where state in ('registering', 'live') order by id`;
  return rows.map((r) => r.id);
}

export async function loadProbeInputs(sql: Sql, apiId: string): Promise<{ op_id: string; input: unknown }[]> {
  return sql<{ op_id: string; input: unknown }[]>`
    select o.op_id, t.input from test_inputs t join operations o on o.id = t.operation_id
    where o.api_id = ${apiId} and o.enabled order by o.op_id, t.id`;
}

export async function touchHealthCheck(sql: Sql, apiId: string): Promise<void> {
  await sql`update apis set health_checked_at = now() where id = ${apiId}`;
}

export async function recordHealthTransition(sql: Sql, apiId: string, from: Health, to: Health, reasons: HealthEventReason[]): Promise<void> {
  await sql`
    with upd as (update apis set health = ${to}, health_checked_at = now() where id = ${apiId} returning id)
    insert into health_events (api_id, from_health, to_health, reasons)
    select id, ${from}, ${to}, ${json(sql, reasons)} from upd`;
}

// ---------------------------------------------------------------- rules and challenges

export async function getRuleByHash(sql: Sql, hash: string): Promise<(RuleRow & { created_at: Date }) | null> {
  const [row] = await sql<(RuleRow & { created_at: Date })[]>`
    select id, operation_id, version, definition, hash, plain_english, created_at from rules where hash = ${hash}`;
  return row ?? null;
}

export async function getActiveHttpChallenge(sql: Sql, apiId: string): Promise<{ id: string; token: string } | null> {
  const [row] = await sql<{ id: string; token: string }[]>`
    select id, token from challenges
    where api_id = ${apiId} and kind = 'http' and consumed_at is null and expires_at > now()
    order by expires_at desc limit 1`;
  return row ?? null;
}


export type ReceiptToken = { id: string; packId: string; status: CreditStatus; remaining: number; txHash: string | null; createdAt: Date };
export type ReceiptCall = {
  at: Date; opId: string; verdict: "pass" | "fail" | "n/a"; charged: boolean; reasons: unknown;
  ruleHash: string | null; ruleVersion: number | null; latencyMs: number | null; inputHash: string | null; outputHash: string | null;
};

/**
 * The token holder's own history: every credit call made with it. A call is charged exactly when the upstream
 * answered and the answer passed (the same condition credits.ts keeps the reserved credit on).
 */
export async function getReceipts(sql: Sql, apiId: string, tokenHash: string, limit = 200): Promise<{ token: ReceiptToken; calls: ReceiptCall[] } | null> {
  const [t] = await sql<{ id: string; pack_id: string; status: CreditStatus; remaining: number; tx_hash: string | null; created_at: Date }[]>`
    select id, pack_id, status, remaining, tx_hash, created_at from credit_tokens where token_hash = ${tokenHash} and api_id = ${apiId}`;
  if (!t) return null;
  const rows = await sql<{
    created_at: Date; op_id: string; verdict: "pass" | "fail" | "n/a"; execution: string; verdict_reasons: unknown;
    hash: string | null; version: number | null; latency_ms: number | null; input_hash: string | null; output_hash: string | null;
  }[]>`
    select c.created_at, c.op_id, c.verdict, c.execution, c.verdict_reasons, r.hash, r.version, c.latency_ms, c.input_hash, c.output_hash
    from calls c left join rules r on r.id = c.rule_id
    where c.credit_token_id = ${t.id} and c.kind = 'credit'
    order by c.created_at desc, c.id desc limit ${limit}`;
  return {
    token: { id: t.id, packId: t.pack_id, status: t.status, remaining: t.remaining, txHash: t.tx_hash, createdAt: t.created_at },
    calls: rows.map((c) => ({
      at: c.created_at, opId: c.op_id, verdict: c.verdict, charged: c.execution === "upstream_ok" && c.verdict === "pass",
      reasons: c.verdict_reasons, ruleHash: c.hash, ruleVersion: c.version, latencyMs: c.latency_ms,
      inputHash: c.input_hash, outputHash: c.output_hash,
    })),
  };
}
