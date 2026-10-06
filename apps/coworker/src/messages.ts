import type { Db } from "./db.js";

/** Sokosumi task-event statuses the coworker sets (verified enum in the preprod OpenAPI). */
export type TaskStatus = "RUNNING" | "INPUT_REQUIRED" | "COMPLETED" | "FAILED";

export type MessageInput = {
  apiId: string | null;
  /** Sokosumi task id; when omitted it is copied from apis.sokosumi_task_id. */
  taskId?: string | null;
  body: string;
  taskStatus?: TaskStatus | null;
  /** Same key twice = same message; the second insert is a no-op. */
  dedupeKey: string;
};

/** Appends a coworker message to the outbox. Returns false when the dedupe key already exists. */
export async function enqueueMessage(db: Db, m: MessageInput): Promise<boolean> {
  const r = await db.query(
    `insert into messages (api_id, seller_id, task_id, author, body, task_status, dedupe_key)
     values ($1, (select seller_id from apis where id = $1), coalesce($2, (select sokosumi_task_id from apis where id = $1)), 'coworker', $3, $4, $5)
     on conflict (dedupe_key) do nothing`,
    [m.apiId, m.taskId ?? null, m.body, m.taskStatus ?? null, m.dedupeKey],
  );
  return r.rowCount === 1;
}
