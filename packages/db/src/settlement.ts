// PACK_MODE=hybrid: the inputs of the settlement policy, and the decisions a 402 offered.
import type postgres from "postgres";
import type { Sql } from "./client";
import type { Health } from "./gateway";

export type SettlementDecisionRow = {
  decision_key: string; api_id: string; pack_id: string; mode: "direct" | "escrow"; reasons: string[]; expires_at: Date;
};
export type SettlementDecisionInsert = { apiId: string; packId: string; mode: "direct" | "escrow"; reasons: string[]; ttlSeconds: number };

const live = (sql: Sql, key: string) => sql<SettlementDecisionRow[]>`
  select decision_key, api_id, pack_id, mode, reasons, expires_at from settlement_decisions
  where decision_key = ${key} and expires_at > now()`;

/**
 * The live decision for this key, else `fresh()` stored in its place. First writer wins: a concurrent caller
 * whose insert loses gets the winner's row, so every 402 and paid retry for the key see one answer.
 */
export async function getOrCreateSettlementDecision(
  sql: Sql, key: string, fresh: () => Promise<SettlementDecisionInsert>,
): Promise<SettlementDecisionRow> {
  const [have] = await live(sql, key);
  if (have) return have;
  const d = await fresh();
  const [row] = await sql<SettlementDecisionRow[]>`
    insert into settlement_decisions (decision_key, api_id, pack_id, mode, reasons, expires_at)
    values (${key}, ${d.apiId}, ${d.packId}, ${d.mode}, ${sql.json(d.reasons as postgres.JSONValue)}, now() + (${d.ttlSeconds} * interval '1 second'))
    on conflict (decision_key) do update set
      api_id = excluded.api_id, pack_id = excluded.pack_id, mode = excluded.mode, reasons = excluded.reasons,
      expires_at = excluded.expires_at, created_at = now()
    where settlement_decisions.expires_at <= now()
    returning decision_key, api_id, pack_id, mode, reasons, expires_at`;
  if (row) return row;
  const [winner] = await live(sql, key);
  if (!winner) throw new Error(`settlement decision ${key} vanished`);
  return winner;
}

/** Optional cleanup: decisions a day past their expiry. */
export async function deleteStaleDecisions(sql: Sql, olderThanSeconds = 86_400): Promise<number> {
  const rows = await sql`
    delete from settlement_decisions where expires_at < now() - (${olderThanSeconds} * interval '1 second') returning decision_key`;
  return rows.length;
}

export type SettlementSignals = {
  now: Date;
  /** apis.created_at: when the listing was made. */
  listedAt: Date;
  /** The later of now - windowDays and listedAt. */
  windowStart: Date;
  /** Health at windowStart: the last transition before it, else "healthy" (a new listing's default). */
  startHealth: Health;
  /** health_events transitions after windowStart, oldest first. */
  events: { to: Health; at: Date }[];
};

/** One query: the listing's age and its health_events over the uptime window. */
export async function loadSettlementSignals(sql: Sql, apiId: string, windowDays: number): Promise<SettlementSignals | null> {
  const [r] = await sql<{ now: Date; listed_at: Date; window_start: Date; start_health: Health | null; events: { to: Health; at: string }[] }[]>`
    with w as (
      select a.id, now() as now, a.created_at as listed_at,
             greatest(now() - (${windowDays} * interval '1 day'), a.created_at) as window_start
      from apis a where a.id = ${apiId}
    )
    select w.now, w.listed_at, w.window_start,
      (select h.to_health from health_events h where h.api_id = w.id and h.at <= w.window_start
        order by h.at desc, h.id desc limit 1) as start_health,
      coalesce((select json_agg(json_build_object('to', h.to_health, 'at', h.at) order by h.at, h.id)
        from health_events h where h.api_id = w.id and h.at > w.window_start and h.at <= w.now), '[]'::json) as events
    from w`;
  if (!r) return null;
  return {
    now: r.now, listedAt: r.listed_at, windowStart: r.window_start, startHealth: r.start_health ?? "healthy",
    events: r.events.map((e) => ({ to: e.to, at: new Date(e.at) })),
  };
}
