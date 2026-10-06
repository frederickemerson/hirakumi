import type { Db } from "./db.js";
import { stepPrefix, type HumanStep } from "./humanSteps.js";

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
  /**
   * The onboarding step this message reports. Messages that reach a Sokosumi task get a "Step N of 7, <name>: "
   * prefix (a task has no stepper); dashboard-only messages stay as they are, since the web shows its own stepper.
   */
  step?: HumanStep;
};

/** Appends a coworker message to the outbox. Returns false when the dedupe key already exists. */
export async function enqueueMessage(db: Db, m: MessageInput): Promise<boolean> {
  const r = await db.query(
    `with t as (select coalesce($2, (select sokosumi_task_id from apis where id = $1)) as task_id)
     insert into messages (api_id, seller_id, task_id, author, body, task_status, dedupe_key)
     select $1, (select seller_id from apis where id = $1), t.task_id, 'coworker',
            case when t.task_id is not null and $6::text is not null then $6 || $3 else $3 end, $4, $5
     from t
     on conflict (dedupe_key) do nothing`,
    [m.apiId, m.taskId ?? null, m.body, m.taskStatus ?? null, m.dedupeKey, m.step ? stepPrefix(m.step) : null],
  );
  return r.rowCount === 1;
}
