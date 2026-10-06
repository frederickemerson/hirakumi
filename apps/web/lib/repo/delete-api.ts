import type postgres from "postgres";
import { deleteBlocker } from "../api-delete";
import type { Sql } from "../db";
import type { ApiState } from "../types";

type Tx = postgres.TransactionSql;
type ApiRef = string | postgres.PendingQuery<postgres.Row[]>;

/** The register step has a row once the coworker started it (any status): Masumi may know this API. */
export const registerStartedSql = (sql: Sql | Tx, apiId: ApiRef) =>
  sql`exists (select 1 from onboard_steps s where s.api_id = ${apiId} and s.step = 'register')`;

/** A buyer paid (or is paying) for a pack, or for a job that did not simply expire unpaid. */
export const soldSql = (sql: Sql | Tx, apiId: ApiRef) =>
  sql`(exists (select 1 from credit_tokens t where t.api_id = ${apiId})
       or exists (select 1 from jobs j where j.api_id = ${apiId} and j.status <> 'expired'))`;

/**
 * Every table holding rows of one API, children before parents so no foreign key is ever violated.
 * The delete test walks pg_constraint and fails if a table referencing apis (directly or through these) is missing.
 * Tables that can only hold rows once something sold (credit_tokens, pack_channels, channel_leases) are listed
 * too: the rule refuses those APIs, and listing them keeps the order correct if that rule ever changes.
 */
export const API_DELETE_ORDER: { table: string; run: (tx: Tx, apiId: string) => postgres.PendingQuery<postgres.Row[]> }[] = [
  { table: "channel_leases", run: (tx, id) => tx`delete from channel_leases where channel_id in (select channel_id from pack_channels where api_id = ${id})` },
  { table: "pack_channels", run: (tx, id) => tx`delete from pack_channels where api_id = ${id}` },
  { table: "pack_quotes", run: (tx, id) => tx`delete from pack_quotes where api_id = ${id}` },
  { table: "calls", run: (tx, id) => tx`delete from calls where api_id = ${id}` },
  { table: "credit_tokens", run: (tx, id) => tx`delete from credit_tokens where api_id = ${id}` },
  { table: "jobs", run: (tx, id) => tx`delete from jobs where api_id = ${id}` },
  { table: "try_tokens", run: (tx, id) => tx`delete from try_tokens where api_id = ${id}` },
  { table: "packs", run: (tx, id) => tx`delete from packs where api_id = ${id}` },
  { table: "test_inputs", run: (tx, id) => tx`delete from test_inputs where operation_id in (select id from operations where api_id = ${id})` },
  { table: "rules", run: (tx, id) => tx`delete from rules where operation_id in (select id from operations where api_id = ${id})` },
  { table: "operations", run: (tx, id) => tx`delete from operations where api_id = ${id}` },
  { table: "challenges", run: (tx, id) => tx`delete from challenges where api_id = ${id}` },
  { table: "onboard_steps", run: (tx, id) => tx`delete from onboard_steps where api_id = ${id}` },
  { table: "messages", run: (tx, id) => tx`delete from messages where api_id = ${id}` },
  { table: "health_events", run: (tx, id) => tx`delete from health_events where api_id = ${id}` },
];

export type DeleteApiResult = { ok: true; name: string } | { ok: false; status: 404 | 409; error: string };

/**
 * Delete an API that never reached the registry, with all its rows, in one transaction. The API row is locked
 * first, so a publish or a sale racing this request either finishes before (and the rule refuses) or finds no API.
 */
export async function deleteUnfinishedApi(sql: Sql, a: { apiId: string; sellerId: string }): Promise<DeleteApiResult> {
  return sql.begin(async (tx): Promise<DeleteApiResult> => {
    const [api] = await tx<{ name: string; state: ApiState; agentIdentifier: string | null }[]>`
      select name, state, agent_identifier from apis where id = ${a.apiId} and seller_id = ${a.sellerId} for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    const [facts] = await tx<{ registerStarted: boolean; sold: boolean }[]>`
      select ${registerStartedSql(tx, a.apiId)} as register_started, ${soldSql(tx, a.apiId)} as sold`;
    const blocker = deleteBlocker({ state: api.state, agentIdentifier: api.agentIdentifier, ...facts });
    if (blocker) return { ok: false, status: 409, error: blocker };
    for (const step of API_DELETE_ORDER) await step.run(tx, a.apiId);
    await tx`delete from apis where id = ${a.apiId}`;
    return { ok: true, name: api.name };
  });
}
