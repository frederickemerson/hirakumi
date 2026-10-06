import type { Sql } from "../db";

export type PackSale = {
  id: string;
  createdAt: Date;
  payer: string | null;
  calls: number;
  priceMicros: string;
  status: "pending" | "active" | "exhausted" | "revoked";
  remaining: number;
  txHash: string | null;
};

export type EscrowJob = {
  id: string;
  createdAt: Date;
  status: "awaiting_payment" | "running" | "completed" | "failed" | "expired";
  identifierFromPurchaser: string;
  blockchainIdentifier: string | null;
  failureReasons: unknown;
};

export async function listPackSales(sql: Sql, apiId: string, limit = 100): Promise<PackSale[]> {
  return sql<PackSale[]>`
    select t.id, t.created_at, t.payer, p.calls, p.price_micros::text as price_micros, t.status, t.remaining, t.tx_hash
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId}
    order by t.created_at desc limit ${limit}`;
}

export async function listEscrowJobs(sql: Sql, apiId: string, limit = 100): Promise<EscrowJob[]> {
  return sql<EscrowJob[]>`
    select id, created_at, status, identifier_from_purchaser, blockchain_identifier, failure_reasons
    from jobs where api_id = ${apiId}
    order by created_at desc limit ${limit}`;
}
export type OverviewStats = {
  callsDay: number;
  passDay: number;
  failDay: number;
  passRate: number | null;
  packSales: number;
  packEarningsMicros: string;
  escrowJobs: number;
  escrowGrossMicros: string;
  escrowFeeMicros: string;
  escrowNetMicros: string;
};

const MASUMI_FEE_PERCENT = 5n;

export async function getOverviewStats(sql: Sql, apiId: string): Promise<OverviewStats> {
  const [calls] = await sql<{ callsDay: number; passDay: number; failDay: number }[]>`
    select count(*)::int as calls_day,
           count(*) filter (where verdict = 'pass')::int as pass_day,
           count(*) filter (where verdict = 'fail')::int as fail_day
    from calls
    where api_id = ${apiId} and kind in ('credit', 'escrow') and created_at > now() - interval '24 hours'`;
  const [packs] = await sql<{ packSales: number; packEarningsMicros: string }[]>`
    select count(*)::int as pack_sales, coalesce(sum(p.price_micros), 0)::text as pack_earnings_micros
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId} and t.status <> 'pending'`;
  const [escrow] = await sql<{ escrowJobs: number; escrowPriceMicros: string | null }[]>`
    select (select count(*)::int from jobs where api_id = ${apiId} and status = 'completed') as escrow_jobs,
           (select escrow_price_micros::text from packs where api_id = ${apiId} order by id limit 1) as escrow_price_micros`;
  const gross = BigInt(escrow.escrowJobs) * BigInt(escrow.escrowPriceMicros ?? "0");
  const fee = (gross * MASUMI_FEE_PERCENT) / 100n;
  const decided = calls.passDay + calls.failDay;
  return {
    callsDay: calls.callsDay,
    passDay: calls.passDay,
    failDay: calls.failDay,
    passRate: decided === 0 ? null : calls.passDay / decided,
    packSales: packs.packSales,
    packEarningsMicros: packs.packEarningsMicros,
    escrowJobs: escrow.escrowJobs,
    escrowGrossMicros: gross.toString(),
    escrowFeeMicros: fee.toString(),
    escrowNetMicros: (gross - fee).toString(),
  };
}

export type Incident = { downAt: Date; upAt: Date | null; reasons: unknown; creditsUsed: number; callsNotPassed: number };

/** Each down event, when it ended, and what paid calls did meanwhile (spec flow 4.6). */
export async function listIncidents(sql: Sql, apiId: string, limit = 5): Promise<Incident[]> {
  return sql<Incident[]>`
    select d.at as down_at, d.reasons, u.up_at, c.credits_used, c.calls_not_passed
    from health_events d
    left join lateral (
      select min(h.at) as up_at from health_events h
      where h.api_id = d.api_id and h.to_health = 'healthy' and h.at > d.at
    ) u on true
    left join lateral (
      select count(*) filter (where k.kind = 'credit' and k.verdict = 'pass')::int as credits_used,
             count(*) filter (where k.kind in ('credit', 'escrow')
                                and (k.verdict = 'fail' or k.execution <> 'upstream_ok'))::int as calls_not_passed
      from calls k
      where k.api_id = d.api_id and k.created_at >= d.at and k.created_at < coalesce(u.up_at, now())
    ) c on true
    where d.api_id = ${apiId} and d.to_health = 'down'
    order by d.at desc
    limit ${limit}`;
}
