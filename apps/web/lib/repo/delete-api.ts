import type postgres from "postgres";
import { recordsKeptReason } from "../api-delete";
import type { Sql } from "../db";
import type { ApiState } from "../types";
import { undoMessage, undoSteps } from "../front-door";
import { detachFrontDoor, postUndoMessage } from "./front-door";
import { hasAnyApiSchema } from "./schema";

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
 * too: those APIs are hidden instead (recordsKeptReason), and listing them keeps the order correct if that rule ever changes.
 */
export const API_DELETE_ORDER: { table: string; run: (tx: Tx, apiId: string) => postgres.PendingQuery<postgres.Row[]> }[] = [
  { table: "channel_leases", run: (tx, id) => tx`delete from channel_leases where channel_id in (select channel_id from pack_channels where api_id = ${id})` },
  { table: "pack_channels", run: (tx, id) => tx`delete from pack_channels where api_id = ${id}` },
  { table: "pack_quotes", run: (tx, id) => tx`delete from pack_quotes where api_id = ${id}` },
  { table: "settlement_decisions", run: (tx, id) => tx`delete from settlement_decisions where api_id = ${id}` },
  { table: "calls", run: (tx, id) => tx`delete from calls where api_id = ${id}` },
  { table: "try_call_slots", run: (tx, id) => tx`delete from try_call_slots where credit_token_id in (select id from credit_tokens where api_id = ${id})` },
  { table: "credit_tokens", run: (tx, id) => tx`delete from credit_tokens where api_id = ${id}` },
  { table: "jobs", run: (tx, id) => tx`delete from jobs where api_id = ${id}` },
  { table: "try_tokens", run: (tx, id) => tx`delete from try_tokens where api_id = ${id}` },
  { table: "self_test_packs", run: (tx, id) => tx`delete from self_test_packs where api_id = ${id}` },
  { table: "packs", run: (tx, id) => tx`delete from packs where api_id = ${id}` },
  { table: "test_inputs", run: (tx, id) => tx`delete from test_inputs where operation_id in (select id from operations where api_id = ${id})` },
  { table: "rules", run: (tx, id) => tx`delete from rules where operation_id in (select id from operations where api_id = ${id})` },
  { table: "operations", run: (tx, id) => tx`delete from operations where api_id = ${id}` },
  { table: "challenges", run: (tx, id) => tx`delete from challenges where api_id = ${id}` },
  { table: "onboard_steps", run: (tx, id) => tx`delete from onboard_steps where api_id = ${id}` },
  { table: "messages", run: (tx, id) => tx`delete from messages where api_id = ${id}` },
  { table: "health_events", run: (tx, id) => tx`delete from health_events where api_id = ${id}` },
];

/** The last word on a Sokosumi task whose API the seller deleted before publishing. */
export const DELETED_TASK_MESSAGE = "You deleted this API. Nothing was published.";

/** The last word on a Sokosumi task whose API the seller deleted while it was being published. */
export const DELETED_REGISTERING_TASK_MESSAGE = "You deleted this API. It won't go on the market.";

export type DeleteApiResult =
  | {
    ok: true; name: string; recordsKept: boolean; wasServing: boolean;
    /** The front-door host it was detached from (the gateway forgets it), and what the seller undoes on their side. */
    frontDoorHost: string | null; undo: string[];
  }
  | { ok: false; status: 404; error: string };

/**
 * Delete an API at any stage, in one transaction. The API row is locked first, so a publish or a sale racing
 * this request either finishes before (and the API is hidden, not erased) or finds no API.
 * - Never reached the registry and nobody paid: the API and every row of it are erased.
 * - Otherwise: it is retired (off the market, every guarded state change stops) and hidden from the seller,
 *   and its rows stay for the registry entry, buyers' receipts and escrow channels the gateway still settles.
 * `wasServing`: the gateway may hold it (registering or live), so the caller asks the gateway to reload it.
 */
export async function deleteApi(sql: Sql, a: { apiId: string; sellerId: string }): Promise<DeleteApiResult> {
  return sql.begin(async (tx): Promise<DeleteApiResult> => {
    const [api] = await tx<{ name: string; state: ApiState; agentIdentifier: string | null; sokosumiTaskId: string | null }[]>`
      select name, state, agent_identifier, sokosumi_task_id from apis
      where id = ${a.apiId} and seller_id = ${a.sellerId} and deleted_at is null for update`;
    if (!api) return { ok: false, status: 404, error: "We couldn't find that API in your account." };
    const [facts] = await tx<{ registerStarted: boolean; sold: boolean }[]>`
      select ${registerStartedSql(tx, a.apiId)} as register_started, ${soldSql(tx, a.apiId)} as sold`;
    const recordsKept = recordsKeptReason({ state: api.state, agentIdentifier: api.agentIdentifier, ...facts }) !== null;
    // The whole monetization layer goes: the front door is detached before the row changes or is erased.
    const hadKey = (await hasAnyApiSchema(tx))
      ? (await tx<{ has: boolean }[]>`select upstream_auth is not null as has from apis where id = ${a.apiId}`)[0]?.has === true
      : false;
    const frontDoorHost = await detachFrontDoor(tx, a.apiId);
    const undo = undoSteps({ frontDoorHost, hadKey });
    if (recordsKept) {
      // Before migration 0014 there is no upstream_auth column, so no key to drop (lib/repo/schema.ts).
      if (await hasAnyApiSchema(tx)) {
        await tx`update apis set state = 'retired', deleted_at = now(), upstream_auth = null where id = ${a.apiId}`;
      } else {
        await tx`update apis set state = 'retired', deleted_at = now() where id = ${a.apiId}`;
      }
    } else {
      for (const step of API_DELETE_ORDER) await step.run(tx, a.apiId);
      await tx`delete from apis where id = ${a.apiId}`;
    }
    // A live or retired API's task already ended; one still being listed would otherwise wait on the coworker.
    if (api.sokosumiTaskId && api.state !== "live" && api.state !== "retired") {
      // The coworker's outbox posts this to the task and closes it, so the seller isn't left waiting on it.
      // api_id is null: the outbox needs only the task id, and an erased API has no row to point at.
      const body = recordsKept ? DELETED_REGISTERING_TASK_MESSAGE : DELETED_TASK_MESSAGE;
      await tx`
        insert into messages (api_id, seller_id, task_id, author, body, task_status, dedupe_key)
        values (null, ${a.sellerId}, ${api.sokosumiTaskId}, 'coworker', ${body}, 'FAILED', ${`deleted:${a.apiId}`})
        on conflict (dedupe_key) do nothing`;
    }
    if (undo.length) {
      await postUndoMessage(tx, { apiId: recordsKept ? a.apiId : null, sellerId: a.sellerId, body: undoMessage(api.name, undo) });
    }
    return { ok: true, name: api.name, recordsKept, wasServing: api.state === "live" || api.state === "registering", frontDoorHost, undo };
  });
}
