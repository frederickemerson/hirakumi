import type pg from "pg";
import type { TaskStatus } from "../messages.js";
import { expandActLinks } from "./actLinks.js";
import { SokosumiHttpError, type SokosumiClient } from "./client.js";

export const MAX_DELIVERY_ATTEMPTS = 10;

type Row = { id: string; api_id: string | null; task_id: string; body: string; task_status: TaskStatus | null };

/**
 * Posts undelivered coworker messages to their Sokosumi task, oldest first. A status the task can't
 * move to (400/409/422) is retried as a plain comment so the seller still sees the text. A failure
 * blocks later messages of the same task for this pass, keeping per-task order.
 */
export async function deliverMessages(pool: pg.Pool, soko: SokosumiClient, webBaseUrl?: string): Promise<number> {
  const { rows } = await pool.query<Row>(
    `select id, api_id, task_id, body, task_status from messages
     where delivered_at is null and author = 'coworker' and task_id is not null and delivery_attempts < $1
     order by id limit 20`,
    [MAX_DELIVERY_ATTEMPTS],
  );
  const blocked = new Set<string>();
  let delivered = 0;
  for (const m of rows) {
    if (blocked.has(m.task_id)) continue;
    try {
      // One-time signing links are made now, as the comment is posted (sokosumi/actLinks.ts).
      const comment = webBaseUrl ? await expandActLinks(pool, webBaseUrl, m.api_id, m.body) : m.body;
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
