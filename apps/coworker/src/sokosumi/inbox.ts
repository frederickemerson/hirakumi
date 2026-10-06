import { randomBytes } from "node:crypto";
import type pg from "pg";
import { withTx } from "../db.js";
import { setupLink } from "../links.js";
import { enqueueMessage } from "../messages.js";
import type { SokosumiClient } from "./client.js";

export const INBOX_PAGE_LIMIT = 50;
export const INBOX_MAX_PAGES = 3;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "DONE"]);

export type InboxDeps = { pool: pg.Pool; soko: SokosumiClient; webBaseUrl: string };

/**
 * Every task assigned to this coworker is an onboarding request (the assignment is the signal, not
 * the title). A task is new when we have no coworker_tasks row for it; the row insert is the dedupe.
 */
export function createInbox(deps: InboxDeps): { poll(): Promise<number> } {
  const ignored = new Set<string>();
  return {
    async poll() {
      const taskIds = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < INBOX_MAX_PAGES; page++) {
        const { events, nextCursor } = await deps.soko.listEvents({ limit: INBOX_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
        for (const e of events) if (e.taskId && e.actor?.type !== "coworker") taskIds.add(e.taskId);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      let created = 0;
      for (const taskId of taskIds) {
        if (ignored.has(taskId)) continue;
        const known = await deps.pool.query(`select 1 from coworker_tasks where task_id = $1`, [taskId]);
        if (known.rowCount) continue;
        const task = await deps.soko.getTask(taskId);
        if (TERMINAL.has(task.status.toUpperCase())) {
          ignored.add(taskId);
          continue;
        }
        const token = randomBytes(24).toString("base64url");
        const inserted = await withTx(deps.pool, async (c) => {
          const r = await c.query(
            `insert into coworker_tasks (task_id, sokosumi_user_id, sokosumi_organization_id, task_name, setup_token)
             values ($1, $2, $3, $4, $5) on conflict (task_id) do nothing`,
            [taskId, task.userId, task.organizationId, task.name, token],
          );
          if (r.rowCount !== 1) return false;
          await enqueueMessage(c, {
            apiId: null,
            taskId,
            body: `Hi! I'll put your API on the agent market. Open this setup link and paste your OpenAPI URL (about 3 minutes, 4 clicks): ${setupLink(deps.webBaseUrl, token)}`,
            taskStatus: "INPUT_REQUIRED",
            dedupeKey: `setup:${taskId}`,
          });
          return true;
        });
        if (inserted) created++;
      }
      return created;
    },
  };
}
