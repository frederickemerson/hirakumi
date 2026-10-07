import { hashActToken, isActAction, isActTokenShape, type ActAction } from "@hirakumi/core";
import type { Sql } from "../db";

/** A one-time link's row (act_tokens, migration 0022). Only the token's hash is stored; the coworker makes them. */
export type ActToken = { id: string; apiId: string; action: ActAction; wallet: string; expired: boolean; used: boolean };

export async function findActToken(sql: Sql, token: string): Promise<ActToken | null> {
  if (!isActTokenShape(token)) return null;
  const [row] = await sql<{ id: string; apiId: string; action: string; wallet: string; expired: boolean; used: boolean }[]>`
    select id, api_id, action, wallet, expires_at <= now() as expired, used_at is not null as used
    from act_tokens where token_hash = ${hashActToken(token)}`;
  return row && isActAction(row.action) ? { ...row, action: row.action } : null;
}

/** Marks the link used, once, while it is still valid. False when it was used or expired in between. */
export async function useActToken(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update act_tokens set used_at = now() where id = ${id} and used_at is null and expires_at > now() returning id`;
  return rows.length === 1;
}

/** Posts to the API's Sokosumi task, once per dedupe key (the coworker's outbox delivers it). */
export async function tellTask(sql: Sql, apiId: string, body: string, dedupeKey: string, status: "RUNNING" | "INPUT_REQUIRED" | null = null): Promise<void> {
  await sql`
    insert into messages (api_id, seller_id, task_id, author, body, task_status, dedupe_key)
    select id, seller_id, sokosumi_task_id, 'coworker', ${body}, ${status}, ${dedupeKey}
    from apis where id = ${apiId} and sokosumi_task_id is not null
    on conflict (dedupe_key) do nothing`;
}
