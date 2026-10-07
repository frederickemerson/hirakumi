import { actPlaceholder, VERIFY_PASS_TTL_MINUTES } from "@hirakumi/core";
import type pg from "pg";
import { withTx } from "../db.js";
import type { DnsGateway } from "../gateway.js";
import { enqueueMessage } from "../messages.js";
import { apiAuthHint } from "../sokosumi/sellerActions.js";

/**
 * After the ownership comment gives a Sokosumi seller the DNS record, the coworker looks it up itself, with the
 * gateway's check (the one the ownership page asks), until it is found. A pass is recorded exactly as the page
 * records it (challenges.proof passedAt and record, on the API's open 'dns' code), so it counts for the same
 * 30 minutes (core VERIFY_PASS_TTL_MINUTES) and the signing link (/act) accepts it. The first pass of a code
 * posts "Found your record" with the one-time link to sign. A pass older than 30 minutes is looked up again, quietly.
 */
/** How often a record is looked up: often at first, then less, and not at all after two weeks. */
export function dnsCheckIntervalMs(watchingForMs: number): number | null {
  if (watchingForMs < 60 * 60_000) return 15_000;
  if (watchingForMs < 24 * 60 * 60_000) return 2 * 60_000;
  if (watchingForMs < 14 * 24 * 60 * 60_000) return 10 * 60_000;
  return null;
}

type Row = { id: string; api_id: string; origin: string; checked_at: string | null; watch_from: string | null };
export type DnsWatchDeps = { pool: pg.Pool; gateway: DnsGateway; now?: () => Date; log?: Pick<Console, "error"> };

export async function watchDnsOnce(deps: DnsWatchDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const { rows } = await deps.pool.query<Row>(
    // An API replaced on its task (the seller started over there) is not watched: it would post next to the new one.
    `select c.id, c.api_id, a.origin, c.proof->>'checkedAt' as checked_at, c.proof->>'watchFrom' as watch_from
     from challenges c join apis a on a.id = c.api_id
     where c.kind = 'dns' and c.consumed_at is null and a.state = 'endpoints_confirmed' and a.deleted_at is null
       and a.sokosumi_task_id is not null
       and not coalesce((c.proof->>'passedAt')::timestamptz > $1::timestamptz - make_interval(mins => $2), false)
       and not exists (select 1 from apis newer where newer.sokosumi_task_id = a.sokosumi_task_id
                         and newer.id <> a.id and newer.created_at > a.created_at)
     order by c.id limit 50`,
    [now.toISOString(), VERIFY_PASS_TTL_MINUTES],
  );
  let found = 0;
  for (const r of rows) {
    const watchFrom = r.watch_from ? Date.parse(r.watch_from) : now.getTime();
    const interval = dnsCheckIntervalMs(now.getTime() - watchFrom);
    if (interval === null) continue;
    if (r.checked_at && now.getTime() - Date.parse(r.checked_at) < interval) continue;
    await deps.pool.query(
      `update challenges set proof = coalesce(proof, '{}'::jsonb) || jsonb_build_object('checkedAt', $2::text, 'watchFrom', coalesce(proof->>'watchFrom', $2::text))
       where id = $1`,
      [r.id, now.toISOString()],
    );
    let result;
    try {
      result = await deps.gateway.checkChallenge(r.api_id);
    } catch (e) {
      (deps.log ?? console).error(`[dns-watch] ${r.api_id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (result.ok) {
      found++;
      const keyNote = (await apiAuthHint(deps.pool, r.api_id)) ? " and add your API's key there (sealed so only the Hirakumi gateway can read it)" : "";
      const record = result.record;
      await withTx(deps.pool, async (c) => {
        await c.query(
          `update challenges set proof = coalesce(proof, '{}'::jsonb) || jsonb_build_object('passedAt', $2::text, 'record', $3::text)
           where id = $1 and kind = 'dns' and consumed_at is null`,
          [r.id, now.toISOString(), record],
        );
        await enqueueMessage(c, {
          apiId: r.api_id,
          body: `Found your record at \`${record}\`. Keep it in place while your API is listed. ` +
            `Now sign once with your Cardano wallet to prove you own ${hostOf(r.origin)} (no payment)${keyNote}: ${actPlaceholder("ownership")}`,
          taskStatus: "INPUT_REQUIRED",
          dedupeKey: `dns_found:${r.id}`,
          step: "Prove ownership",
        });
      });
    } else if (result.reason === "mismatch") {
      // A record with another code is a real mistake, said once; "not there yet" is the normal wait and says nothing.
      await enqueueMessage(deps.pool, {
        apiId: r.api_id,
        body: `There is a TXT record at \`${result.record}\`, but not with this API's code. Copy the value from my message above again: ` +
          "it must match exactly. Another API on this host may have its own record: keep it and add this one too.",
        taskStatus: "INPUT_REQUIRED",
        dedupeKey: `dns_mismatch:${r.id}`,
        step: "Prove ownership",
      });
    }
  }
  return found;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}
