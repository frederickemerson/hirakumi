import { formatHealthReasons, isOperatorOnly, OPERATOR_KEYS_UNAVAILABLE } from "@hirakumi/core";
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

/** Dedupe key of the late Down message sent for an operator-only Down event (see processSuppressedDowns). */
const lateDownKey = (eventId: string) => `health:${eventId}:seller`;

/**
 * True when the seller should not hear about this event: a Down caused only by our own key problem,
 * or the Live that follows such a Down (unless the seller was told about that Down later on).
 */
async function operatorOnly(pool: pg.Pool, e: Row): Promise<boolean> {
  if (e.to_health === "down") return isOperatorOnly(e.reasons);
  const { rows } = await pool.query<{ reasons: unknown; told: boolean }>(
    `select he.reasons, exists (select 1 from messages m where m.dedupe_key = 'health:' || he.id || ':seller') as told
     from health_events he where he.api_id = $1 and he.id < $2 and he.to_health = 'down' order by he.id desc limit 1`,
    [e.api_id, e.id],
  );
  return rows.length > 0 && isOperatorOnly(rows[0].reasons) && !rows[0].told;
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
  return rows.length + (await processSuppressedDowns(pool, webBaseUrl));
}

/**
 * Messages the seller about an operator-only Down that their own problem now keeps Down. The gateway writes no event
 * while an API stays Down, so when our keys come back but the probes fail (their key is refused, or the API broke),
 * nothing else would tell them. The operator path writes no probe rows, so any failing probe after the event, in the
 * current failure run, is the seller's. The message is sent once per event, and the Live after it is then announced.
 */
async function processSuppressedDowns(pool: pg.Pool, webBaseUrl: string): Promise<number> {
  const { rows } = await pool.query<{ id: string; api_id: string; reasons: unknown; at: Date; name: string }>(
    `select he.id, he.api_id, he.reasons, he.at, a.name
     from health_events he join apis a on a.id = he.api_id
     where he.to_health = 'down' and he.notified_at is not null and a.health = 'down'
       and he.reasons @> jsonb_build_array(jsonb_build_object('reason', $1::text))
       and not exists (select 1 from health_events l where l.api_id = he.api_id and l.id > he.id)
       and not exists (select 1 from messages m where m.dedupe_key = 'health:' || he.id || ':seller')
     order by he.id limit 50`,
    [OPERATOR_KEYS_UNAVAILABLE],
  );
  let sent = 0;
  for (const e of rows) {
    if (!isOperatorOnly(e.reasons)) continue;
    const { rows: fails } = await pool.query<{ op_id: string; verdict_reasons: unknown; execution: string; created_at: Date }>(
      `select op_id, verdict_reasons, execution, created_at from calls
       where api_id = $1 and kind = 'probe' and verdict <> 'pass' and created_at > $2
         and created_at > coalesce(
           (select max(created_at) from calls where api_id = $1 and kind = 'probe' and verdict = 'pass'), '-infinity'::timestamptz)
       order by created_at`,
      [e.api_id, e.at],
    );
    if (fails.length === 0) continue;
    const reasons = fails.flatMap((f) => {
      const texts = Array.isArray(f.verdict_reasons) && f.verdict_reasons.length ? f.verdict_reasons : [f.execution];
      return texts.map((reason) => ({ op: f.op_id, reason }));
    });
    const body = downBody(e.name, e.api_id, formatHealthReasons(reasons), fails[0].created_at, webBaseUrl);
    if (await enqueueMessage(pool, { apiId: e.api_id, body, dedupeKey: lateDownKey(e.id) })) sent += 1;
  }
  return sent;
}
