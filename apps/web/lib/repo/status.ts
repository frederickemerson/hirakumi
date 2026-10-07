import type { Sql } from "../db";
import { hasSelfTestSchema } from "./self-test-schema";
import { notSelfTestCall } from "./stats";

export type HourState = "up" | "degraded" | "down" | "no_data";
export type StatusHour = { start: Date; probes: number; passed: number; state: HourState };
export type PublicStatus = {
  /** Share of monitor probes that kept the promise in the last 24 hours; null without probes. */
  uptimePct: number | null;
  /** 24 hourly buckets, oldest first. */
  hours: StatusHour[];
  /** Paid calls (credit and escrow) in the last 24 hours and the share that kept the promise. A seller's own tests don't count. */
  paidCalls: number;
  passRatePct: number | null;
  /** Median latency of passing probes in the last 24 hours, in ms. */
  p50LatencyMs: number | null;
};

const HOUR = 3_600_000;

export async function getPublicStatus(sql: Sql, apiId: string, now: Date = new Date()): Promise<PublicStatus> {
  const since = new Date(now.getTime() - 24 * HOUR);
  const ready = await hasSelfTestSchema(sql);
  const firstHour = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 23 * HOUR);
  const [probeRows, [paid], [lat]] = await Promise.all([
    sql<{ bucket: Date; probes: number; passed: number }[]>`
      select date_trunc('hour', created_at) as bucket, count(*)::int as probes,
             count(*) filter (where verdict = 'pass')::int as passed
      from calls where api_id = ${apiId} and kind = 'probe' and created_at > ${since} and created_at <= ${now}
      group by 1`,
    sql<{ total: number; passed: number }[]>`
      select count(*)::int as total, count(*) filter (where verdict = 'pass')::int as passed
      from calls c where c.api_id = ${apiId} and c.kind in ('credit', 'escrow') and c.created_at > ${since} and c.created_at <= ${now}
        and ${sql.unsafe(notSelfTestCall(ready))}`,
    sql<{ p50: number | null }[]>`
      select percentile_cont(0.5) within group (order by latency_ms)::int as p50
      from calls where api_id = ${apiId} and kind = 'probe' and verdict = 'pass' and latency_ms is not null
        and created_at > ${since} and created_at <= ${now}`,
  ]);

  const byHour = new Map(probeRows.map((r) => [new Date(r.bucket).getTime(), r]));
  const hours: StatusHour[] = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(firstHour.getTime() + i * HOUR);
    const r = byHour.get(start.getTime());
    const probes = r?.probes ?? 0;
    const passed = r?.passed ?? 0;
    const state: HourState = probes === 0 ? "no_data" : passed === probes ? "up" : passed === 0 ? "down" : "degraded";
    return { start, probes, passed, state };
  });
  const probes = hours.reduce((n, h) => n + h.probes, 0);
  const passedProbes = hours.reduce((n, h) => n + h.passed, 0);
  return {
    uptimePct: probes ? Math.round((passedProbes / probes) * 100) : null,
    hours,
    paidCalls: paid.total,
    passRatePct: paid.total ? Math.round((paid.passed / paid.total) * 100) : null,
    p50LatencyMs: lat?.p50 ?? null,
  };
}
