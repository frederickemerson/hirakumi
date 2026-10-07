import type { Sql } from "../db";
import { hasSelfTestSchema } from "./self-test-schema";

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

/**
 * The seller testing their own API (migration 0016's self_test_credit_tokens: paid from the API's own payout
 * address, a free test, or bought through the seller's Try it live). Never a sale, never earnings or reputation.
 * `ready`: hasSelfTestSchema; before 0016 ran nothing is a self test.
 */
export const notSelfTest = (alias: string, ready: boolean) =>
  ready ? `not exists (select 1 from self_test_credit_tokens x where x.credit_token_id = ${alias}.id)` : "true";

/** A paid call that counts toward stats: not made with a self-test pack. `c` is the calls row. */
export const notSelfTestCall = (ready: boolean) => ready
  ? "(c.credit_token_id is null or not exists (select 1 from self_test_credit_tokens x where x.credit_token_id = c.credit_token_id))"
  : "true";

/** A pack that sold: paid (settled), never revoked, and not a self test. Needs `credit_tokens t`. */
export const soldToken = (ready: boolean) => `t.status in ('active', 'exhausted') and ${notSelfTest("t", ready)}`;

/**
 * What the seller receives for one sold pack. Needs `packs p` and `left join pack_channels pc on pc.credit_token_id = t.id`.
 * Direct: the pack price. Escrow: the payout once settled; until then the calls the buyer signed for, at the
 * price per call, less the fee. Never the full locked amount: the unused part refunds to the buyer.
 */
export const RECEIVED_MICROS =
  "coalesce(pc.seller_paid_micros, (pc.iou_accepted::bigint * pc.price_per_call_micros * (10000 - pc.fee_bps)) / 10000, p.price_micros)";

export async function listPackSales(sql: Sql, apiId: string, limit = 100): Promise<PackSale[]> {
  const ready = await hasSelfTestSchema(sql);
  return sql<PackSale[]>`
    select t.id, t.created_at, t.payer, p.calls, p.price_micros::text as price_micros, t.status, t.remaining, t.tx_hash
    from credit_tokens t join packs p on p.id = t.pack_id
    where t.api_id = ${apiId} and ${sql.unsafe(notSelfTest("t", ready))}
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

/** Completed escrow jobs at the escrow price: what buyers paid, what Masumi kept, and what reached the seller. */
export function escrowTake(completedJobs: number, escrowPriceMicros: string | null): { gross: bigint; fee: bigint; net: bigint } {
  const gross = BigInt(completedJobs) * BigInt(escrowPriceMicros ?? "0");
  const fee = (gross * MASUMI_FEE_PERCENT) / 100n;
  return { gross, fee, net: gross - fee };
}

export async function getOverviewStats(sql: Sql, apiId: string): Promise<OverviewStats> {
  const ready = await hasSelfTestSchema(sql);
  const [calls] = await sql<{ callsDay: number; passDay: number; failDay: number }[]>`
    select count(*)::int as calls_day,
           count(*) filter (where verdict = 'pass')::int as pass_day,
           count(*) filter (where verdict = 'fail')::int as fail_day
    from calls c
    where c.api_id = ${apiId} and c.kind in ('credit', 'escrow') and c.created_at > now() - interval '24 hours'
      and ${sql.unsafe(notSelfTestCall(ready))}`;
  const [packs] = await sql<{ packSales: number; packEarningsMicros: string }[]>`
    select count(*)::int as pack_sales, coalesce(sum(${sql.unsafe(RECEIVED_MICROS)}), 0)::text as pack_earnings_micros
    from credit_tokens t join packs p on p.id = t.pack_id
    left join pack_channels pc on pc.credit_token_id = t.id
    where t.api_id = ${apiId} and ${sql.unsafe(soldToken(ready))}`;
  const [escrow] = await sql<{ escrowJobs: number; escrowPriceMicros: string | null }[]>`
    select (select count(*)::int from jobs where api_id = ${apiId} and status = 'completed') as escrow_jobs,
           (select escrow_price_micros::text from packs where api_id = ${apiId} order by id limit 1) as escrow_price_micros`;
  const { gross, fee, net } = escrowTake(escrow.escrowJobs, escrow.escrowPriceMicros);
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
    escrowNetMicros: net.toString(),
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
    -- A "down" to "down" event only says who is to blame now (apps/gateway health.ts): the same incident.
    where d.api_id = ${apiId} and d.to_health = 'down' and d.from_health <> 'down'
    order by d.at desc
    limit ${limit}`;
}
