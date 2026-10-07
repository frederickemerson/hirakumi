import type postgres from "postgres";
import { shortAddress } from "../copy";
import type { Sql } from "../db";
import { findCoworkerTask, sokosumiLock } from "./apis";

/**
 * Which wallet a Sokosumi account is linked to (sellers.sokosumi_user_id). Listings from that account's tasks
 * belong to the linked wallet. The link is made, moved or removed only by an explicit action of the signed-in seller.
 *
 * - none: no wallet holds this Sokosumi account, and this wallet holds no other one
 * - here: this wallet holds it
 * - elsewhere: another wallet holds it (address: that wallet)
 * - conflict: this wallet already holds a different Sokosumi account
 */
export type SokosumiLink =
  | { status: "none" }
  | { status: "here" }
  | { status: "elsewhere"; address: string }
  | { status: "conflict" };

/** API states whose listing is (or is becoming) live, or is over: they stay with the wallet that listed them. */
export const PINNED_STATES = ["live", "registering", "retired"] as const;

async function linkState(sql: Sql | postgres.TransactionSql, sokosumiUserId: string, sellerId: string): Promise<SokosumiLink> {
  const [me] = await sql<{ sokosumiUserId: string | null }[]>`select sokosumi_user_id from sellers where id = ${sellerId}`;
  if (me?.sokosumiUserId === sokosumiUserId) return { status: "here" };
  if (me?.sokosumiUserId) return { status: "conflict" };
  const [other] = await sql<{ cardanoAddr: string }[]>`
    select cardano_addr from sellers where sokosumi_user_id = ${sokosumiUserId} and id <> ${sellerId}
    order by created_at limit 1`;
  return other ? { status: "elsewhere", address: other.cardanoAddr } : { status: "none" };
}

/** The link as seen from a setup link, or null when the setup link is unknown. */
export async function sokosumiLinkForToken(sql: Sql, setupToken: string, sellerId: string): Promise<SokosumiLink | null> {
  if (!setupToken || setupToken.includes("\u0000")) return null;
  const task = await findCoworkerTask(sql, setupToken);
  return task ? linkState(sql, task.sokosumiUserId, sellerId) : null;
}

export type LinkResult =
  | { ok: true; moved: string[]; already: boolean }
  | { ok: false; reason: "conflict" };

/**
 * Link the Sokosumi account behind a setup link to this seller, moving it from any other wallet. That account's
 * APIs on the other wallet that aren't live, registering or retired move with it, and each of their tasks is told.
 * Authorization: the private setup token plus a signed-in session for this wallet (the same as the first claim).
 */
export async function linkSokosumi(
  sql: Sql,
  a: { sokosumiUserId: string; sellerId: string; addr: string },
): Promise<LinkResult> {
  return sql.begin(async (tx) => {
    await sokosumiLock(tx, a.sokosumiUserId);
    const state = await linkState(tx, a.sokosumiUserId, a.sellerId);
    if (state.status === "conflict") return { ok: false as const, reason: "conflict" as const };
    if (state.status === "here") return { ok: true as const, moved: [], already: true };
    const previous = await tx<{ id: string }[]>`
      update sellers set sokosumi_user_id = null
      where sokosumi_user_id = ${a.sokosumiUserId} and id <> ${a.sellerId}
      returning id`;
    await tx`update sellers set sokosumi_user_id = ${a.sokosumiUserId} where id = ${a.sellerId}`;
    if (previous.length === 0) return { ok: true as const, moved: [], already: false };
    const moved = await tx<{ id: string; taskId: string }[]>`
      update apis set seller_id = ${a.sellerId}
      where seller_id in ${tx(previous.map((p) => p.id))} and deleted_at is null
        and state not in ${tx(PINNED_STATES as unknown as string[])}
        and sokosumi_task_id in (select task_id from coworker_tasks where sokosumi_user_id = ${a.sokosumiUserId})
      returning id, sokosumi_task_id as task_id`;
    const body = `Your Sokosumi account now uses wallet ${shortAddress(a.addr)}.`;
    const tasks = new Map(moved.map((m) => [m.taskId, m.id]));
    for (const [taskId, apiId] of tasks) {
      await tx`
        insert into messages (api_id, seller_id, task_id, author, body)
        values (${apiId}, ${a.sellerId}, ${taskId}, 'coworker', ${body})`;
    }
    return { ok: true as const, moved: moved.map((m) => m.id), already: false };
  });
}

/** Remove this seller's Sokosumi link. Its listings stay with this wallet. */
export async function unlinkSokosumi(sql: Sql, sellerId: string): Promise<boolean> {
  const rows = await sql`update sellers set sokosumi_user_id = null where id = ${sellerId} and sokosumi_user_id is not null returning id`;
  return rows.length === 1;
}
