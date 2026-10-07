import type pg from "pg";
import type { TaskStatus } from "../messages.js";
import { apiIdOfPageLink } from "../links.js";
import { SokosumiHttpError, type SokosumiClient } from "./client.js";
import { findLinks } from "./replies.js";
import { apiOwnerWallet, walletTail } from "./sellerActions.js";

export const MAX_DELIVERY_ATTEMPTS = 10;

type Row = { id: string; task_id: string; body: string; task_status: TaskStatus | null };

/**
 * Posts undelivered coworker messages to their Sokosumi task, oldest first. A status the task can't
 * move to (400/409/422) is retried as a plain comment so the seller still sees the text. A failure
 * blocks later messages of the same task for this pass, keeping per-task order.
 */
export async function deliverMessages(pool: pg.Pool, soko: SokosumiClient, webBaseUrl?: string): Promise<number> {
  const { rows } = await pool.query<Row>(
    `select id, task_id, body, task_status from messages
     where delivered_at is null and author = 'coworker' and task_id is not null and delivery_attempts < $1
     order by id limit 20`,
    [MAX_DELIVERY_ATTEMPTS],
  );
  const blocked = new Set<string>();
  let delivered = 0;
  for (const m of rows) {
    if (blocked.has(m.task_id)) continue;
    try {
      const comment = webBaseUrl ? await withWalletLine(pool, webBaseUrl, m.body) : m.body;
      try {
        await soko.createTaskEvent(m.task_id, { comment, ...(m.task_status ? { status: m.task_status } : {}) });
      } catch (e) {
        if (!(e instanceof SokosumiHttpError) || !m.task_status || ![400, 409, 422].includes(e.status)) throw e;
        await soko.createTaskEvent(m.task_id, { comment });
      }
      await pool.query(`update messages set delivered_at = now(), last_error = null where id = $1`, [m.id]);
      delivered++;
    } catch (e) {
      blocked.add(m.task_id);
      await pool.query(`update messages set delivery_attempts = delivery_attempts + 1, last_error = $2 where id = $1`, [
        m.id,
        (e instanceof Error ? e.message : String(e)).slice(0, 500),
      ]);
    }
  }
  return delivered;
}

/** Said in a comment that already offers the command (the help text), so it isn't offered twice. */
const LINK_WALLET = "Reply `link wallet`";

/**
 * A comment that links to an API's own pages (ownership, review, overview, endpoints) ends with the wallet those
 * pages open for: a Sokosumi seller signed in with another wallet gets a 404 and can't tell why. The wallet is the
 * API owner's (the first such link's API). Added at delivery, so the dashboard log keeps the plain text.
 */
export async function withWalletLine(db: pg.Pool, webBaseUrl: string, body: string): Promise<string> {
  const apiId = findLinks(body).map((l) => apiIdOfPageLink(webBaseUrl, l)).find((id) => id !== null);
  if (!apiId) return body;
  const addr = await apiOwnerWallet(db, apiId);
  if (!addr) return body;
  const offer = body.includes(LINK_WALLET) ? "" : ` (Different wallet? ${LINK_WALLET}.)`;
  return `${body}\n\nOpen it signed in with the wallet ending ${walletTail(addr)}.${offer}`;
}
