import { formatHealthReasons, isOperatorOnly } from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "./db.js";
import { apiLink } from "./links.js";
import { enqueueMessage } from "./messages.js";

type Row = { id: string; api_id: string; to_health: "healthy" | "down"; reasons: unknown; at: Date; name: string };

export const formatUtc = (d: Date) => `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;

/**
 * Earliest failing probe in the current failure run (probes are calls rows with kind 'probe'). A rate-limited probe
 * (upstream_ok with verdict n/a, apps/gateway monitor.ts) is inconclusive, not a failure.
 */
export async function firstFailureAt(pool: pg.Pool, apiId: string, until: Date): Promise<Date | null> {
  const { rows } = await pool.query<{ first: Date | null }>(
    `select min(created_at) as first from calls
     where api_id = $1 and kind = 'probe' and verdict <> 'pass' and not (execution = 'upstream_ok' and verdict = 'n/a')
       and created_at <= $2
       and created_at > coalesce(
         (select max(created_at) from calls where api_id = $1 and kind = 'probe' and verdict = 'pass' and created_at <= $2),
         '-infinity'::timestamptz)`,
    [apiId, until],
  );
  return rows[0]?.first ?? null;
}

/**
 * True when the seller should not hear about this event: a Down caused only by our own key problem, or the Live
 * that follows such a Down. When such a Down later fails for the seller's own reasons, the gateway writes a "down"
 * to "down" event with those reasons (apps/gateway health.ts), which is messaged like any Down and makes the Live
 * after it announced too.
 */
async function operatorOnly(pool: pg.Pool, e: Row): Promise<boolean> {
  if (e.to_health === "down") return isOperatorOnly(e.reasons);
  const { rows } = await pool.query<{ reasons: unknown }>(
    `select he.reasons from health_events he where he.api_id = $1 and he.id < $2 and he.to_health = 'down' order by he.id desc limit 1`,
    [e.api_id, e.id],
  );
  return rows.length > 0 && isOperatorOnly(rows[0].reasons);
}

function downBody(name: string, apiId: string, reasons: string[], first: Date, webBaseUrl: string): string {
  return `Your API "${name}" is Down. Failing check: ${reasons.length ? reasons.join("; ") : "no details recorded"}. First failed test: ${formatUtc(first)}. Buyers are not charged while it is Down, and the Masumi registry will show it Offline at its next check. Details: ${apiLink(webBaseUrl, apiId)}`;
}

/** Turns unnotified health_events into seller messages; message + notified_at commit together. */
export async function processHealthEvents(pool: pg.Pool, webBaseUrl: string): Promise<number> {
  const { rows } = await pool.query<Row>(
    `select he.id, he.api_id, he.to_health, he.reasons, he.at, a.name
     from health_events he join apis a on a.id = he.api_id
     where he.notified_at is null order by he.id limit 50`,
  );
  for (const e of rows) {
    if (await operatorOnly(pool, e)) {
      await pool.query(`update health_events set notified_at = now() where id = $1 and notified_at is null`, [e.id]);
      continue;
    }
    const reasons = formatHealthReasons(e.reasons);
    let body: string;
    if (e.to_health === "down") {
      const first = (await firstFailureAt(pool, e.api_id, e.at)) ?? e.at;
      body = downBody(e.name, e.api_id, reasons, first, webBaseUrl);
    } else {
      body = `Your API "${e.name}" is Live again (recovered at ${formatUtc(e.at)}). Details: ${apiLink(webBaseUrl, e.api_id)}`;
    }
    await withTx(pool, async (c) => {
      await enqueueMessage(c, { apiId: e.api_id, body, dedupeKey: `health:${e.id}` });
      await c.query(`update health_events set notified_at = now() where id = $1 and notified_at is null`, [e.id]);
    });
  }
  return rows.length;
}
