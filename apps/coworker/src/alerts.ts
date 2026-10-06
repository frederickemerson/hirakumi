import { formatHealthReasons } from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "./db.js";
import { apiLink } from "./links.js";
import { enqueueMessage } from "./messages.js";

type Row = { id: string; api_id: string; to_health: "healthy" | "down"; reasons: unknown; at: Date; name: string };

export const formatUtc = (d: Date) => `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;

/** Earliest failing probe in the current failure run (probes are calls rows with kind 'probe'). */
export async function firstFailureAt(pool: pg.Pool, apiId: string, until: Date): Promise<Date | null> {
  const { rows } = await pool.query<{ first: Date | null }>(
    `select min(created_at) as first from calls
     where api_id = $1 and kind = 'probe' and verdict <> 'pass' and created_at <= $2
       and created_at > coalesce(
         (select max(created_at) from calls where api_id = $1 and kind = 'probe' and verdict = 'pass' and created_at <= $2),
         '-infinity'::timestamptz)`,
    [apiId, until],
  );
  return rows[0]?.first ?? null;
}

/** Turns unnotified health_events into seller messages; message + notified_at commit together. */
export async function processHealthEvents(pool: pg.Pool, webBaseUrl: string): Promise<number> {
  const { rows } = await pool.query<Row>(
    `select he.id, he.api_id, he.to_health, he.reasons, he.at, a.name
     from health_events he join apis a on a.id = he.api_id
     where he.notified_at is null order by he.id limit 50`,
  );
  for (const e of rows) {
    const reasons = formatHealthReasons(e.reasons);
    let body: string;
    if (e.to_health === "down") {
      const first = (await firstFailureAt(pool, e.api_id, e.at)) ?? e.at;
      body = `Your API "${e.name}" is Down. Failing check: ${reasons.length ? reasons.join("; ") : "no details recorded"}. First failed test: ${formatUtc(first)}. Buyers are not charged while it is Down, and the Masumi registry will show it Offline at its next check. Details: ${apiLink(webBaseUrl, e.api_id)}`;
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
