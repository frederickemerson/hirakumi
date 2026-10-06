import { apiBadge, type Account, type AccountApi } from "../account";
import { deleteBlocker } from "../api-delete";
import type { Sql } from "../db";
import { buildTimeline } from "../timeline";
import type { ApiState, Health, OnboardStep } from "../types";
import { ONBOARD_STEP_NAMES } from "./apis";
import { registerStartedSql, soldSql } from "./delete-api";
import { escrowTake } from "./stats";

type Row = {
  cardanoAddr: string;
  sellerCreatedAt: Date;
  sokosumiUserId: string | null;
  id: string | null;
  name: string;
  state: ApiState;
  health: Health;
  healthCheckedAt: Date | null;
  agentIdentifier: string | null;
  createdAt: Date;
  paidCallsDay: number;
  passDay: number;
  failDay: number;
  packMicros: string;
  completedJobs: number;
  escrowPriceMicros: string | null;
  steps: Pick<OnboardStep, "step" | "status" | "output" | "updatedAt">[] | null;
  registerStarted: boolean;
  sold: boolean;
};

/**
 * The account page in one query: the seller, and every API with its 24 hour paid calls, what it received, its
 * onboarding steps and the delete facts. The numbers use the same definitions as getOverviewStats.
 * A seller without APIs still yields one row (the left join), with a null API id.
 */
export async function getAccount(sql: Sql, sellerId: string): Promise<Account | null> {
  const a = sql`a.id`;
  const rows = await sql<Row[]>`
    select s.cardano_addr, s.created_at as seller_created_at, s.sokosumi_user_id,
           a.id, a.name, a.state, a.health, a.health_checked_at, a.agent_identifier, a.created_at,
           coalesce(c.paid_calls_day, 0) as paid_calls_day, coalesce(c.pass_day, 0) as pass_day, coalesce(c.fail_day, 0) as fail_day,
           coalesce(pk.pack_micros, '0') as pack_micros, coalesce(j.completed_jobs, 0) as completed_jobs,
           ep.escrow_price_micros, st.steps,
           coalesce(${registerStartedSql(sql, a)}, false) as register_started,
           coalesce(${soldSql(sql, a)}, false) as sold
    from sellers s
    left join apis a on a.seller_id = s.id
    left join lateral (
      select count(*)::int as paid_calls_day,
             count(*) filter (where verdict = 'pass')::int as pass_day,
             count(*) filter (where verdict = 'fail')::int as fail_day
      from calls where api_id = a.id and kind in ('credit', 'escrow') and created_at > now() - interval '24 hours'
    ) c on true
    left join lateral (
      select coalesce(sum(p.price_micros), 0)::text as pack_micros
      from credit_tokens t join packs p on p.id = t.pack_id
      where t.api_id = a.id and t.status <> 'pending'
    ) pk on true
    left join lateral (
      select count(*)::int as completed_jobs from jobs where api_id = a.id and status = 'completed'
    ) j on true
    left join lateral (
      select escrow_price_micros::text as escrow_price_micros from packs where api_id = a.id order by id limit 1
    ) ep on true
    left join lateral (
      select json_agg(json_build_object('step', step, 'status', status, 'output', output, 'updatedAt', updated_at)
                      order by updated_at) as steps
      from onboard_steps where api_id = a.id and step in ${sql(ONBOARD_STEP_NAMES)}
    ) st on true
    where s.id = ${sellerId}
    order by a.created_at desc nulls last, a.id`;
  if (rows.length === 0) return null;
  const seller = rows[0];
  const apis: AccountApi[] = rows.filter((r) => r.id !== null).map((r) => ({
    id: r.id!,
    name: r.name,
    state: r.state,
    health: r.health,
    healthCheckedAt: r.healthCheckedAt ? r.healthCheckedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    paidCallsDay: r.paidCallsDay,
    passDay: r.passDay,
    failDay: r.failDay,
    receivedMicros: (BigInt(r.packMicros) + escrowTake(r.completedJobs, r.escrowPriceMicros).net).toString(),
    badge: apiBadge(r.state, r.health, buildTimeline(r.state, r.steps ?? [])),
    deleteBlocker: deleteBlocker({ state: r.state, agentIdentifier: r.agentIdentifier, registerStarted: r.registerStarted, sold: r.sold }),
  }));
  return {
    address: seller.cardanoAddr,
    createdAt: seller.sellerCreatedAt.toISOString(),
    sokosumiUserId: seller.sokosumiUserId,
    apis,
  };
}
