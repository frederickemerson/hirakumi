import { randomBytes } from "node:crypto";
import type pg from "pg";
import { withTx } from "../db.js";
import { enqueueMessage } from "../messages.js";
import type { StructuredCall } from "../llm/claude.js";
import { createSpecFetcher } from "../openapi/fetchSpec.js";
import type { SokosumiClient, SokosumiEvent } from "./client.js";
import type { LeakCheck } from "../leakCheck.js";
import { handleBrief, handleReply, resumeLinkedIntakes, type ConversationDeps, type TaskRef } from "./conversation.js";

const INBOX_PAGE_LIMIT = 50;
const INBOX_MAX_PAGES = 3;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "DONE"]);

export type InboxDeps = {
  pool: pg.Pool;
  soko: SokosumiClient;
  webBaseUrl: string;
  fetchSpec?: (url: string) => Promise<string>;
  llm?: StructuredCall | null;
  allowInsecure?: boolean;
  /** Endpoints that need several keys at once are sold too (UPSTREAM_AUTH_V3). */
  multiPartKeys?: boolean;
  /** The leak check before the publish link (leakCheck.ts). */
  leakCheck?: LeakCheck | null;
};

type Row = { task_id: string; sokosumi_user_id: string; setup_token: string; created_at: Date };

const isComment = (e: SokosumiEvent) => e.actor?.type === "user" && typeof e.comment === "string" && e.comment.trim() !== "";
const at = (e: SokosumiEvent) => Date.parse(e.createdAt);

/**
 * Every task assigned to this coworker is an onboarding request (the assignment is the signal, not the title).
 * A task is new when we have no coworker_tasks row for it; the row insert is the dedupe. Its brief (name, description
 * and any comments so far) may already hold the OpenAPI link. Later comments by the task's owner are replies, each
 * acted on once (coworker_task_events is claimed before acting).
 */
export function createInbox(deps: InboxDeps): { poll(): Promise<number> } {
  const ignored = new Set<string>();
  const convo: ConversationDeps = {
    pool: deps.pool,
    webBaseUrl: deps.webBaseUrl,
    fetchSpec: deps.fetchSpec ?? createSpecFetcher(),
    llm: deps.llm ?? null,
    allowInsecure: deps.allowInsecure ?? false,
    multiPartKeys: deps.multiPartKeys ?? false,
    leakCheck: deps.leakCheck ?? null,
  };
  return {
    async poll() {
      // Sellers who just linked their wallet on the setup link: their intake starts now.
      await resumeLinkedIntakes(convo).catch((e: unknown) => console.error(`[inbox] resuming linked intakes: ${(e as Error).message}`));
      const byTask = new Map<string, SokosumiEvent[]>();
      let cursor: string | undefined;
      for (let page = 0; page < INBOX_MAX_PAGES; page++) {
        const { events, nextCursor } = await deps.soko.listEvents({ limit: INBOX_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
        for (const e of events) {
          if (!e.taskId || e.actor?.type === "coworker") continue;
          byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), e]);
        }
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      let created = 0;
      for (const [taskId, events] of byTask) {
        // One task that keeps failing (deleted, forbidden, a bad row) must not starve every task after it.
        try {
          if (ignored.has(taskId)) continue;
          const comments = events.filter(isComment).sort((a, b) => (at(a) || 0) - (at(b) || 0));
          const { rows: [known] } = await deps.pool.query<Row>(
            `select task_id, sokosumi_user_id, setup_token, created_at from coworker_tasks where task_id = $1`, [taskId]);
          if (known) {
            await handleReplies(convo, deps.soko, known, comments, ignored);
            continue;
          }
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
            // Comments already on the task are part of its brief, not replies.
            for (const e of comments) await c.query(`insert into coworker_task_events (event_id, task_id) values ($1, $2) on conflict do nothing`, [e.id, taskId]);
            return true;
          });
          if (!inserted) continue;
          created++;
          const ownComments = comments.filter((e) => e.actor?.id === task.userId).map((e) => e.comment as string);
          const brief = [task.name, task.description ?? "", ...ownComments].join("\n");
          await answered(convo, taskId, `brief:${taskId}`, () => handleBrief(convo, { taskId, sokosumiUserId: task.userId, setupToken: token }, brief));
        } catch (e) {
          console.error(`[inbox] task ${taskId}:`, (e as Error).message);
        }
      }
      return created;
    },
  };
}

async function handleReplies(convo: ConversationDeps, soko: SokosumiClient, row: Row, comments: SokosumiEvent[], ignored: Set<string>) {
  const ref: TaskRef = { taskId: row.task_id, sokosumiUserId: row.sokosumi_user_id, setupToken: row.setup_token };
  let checkedOpen = false;
  for (const e of comments) {
    // Only comments written after we took the task are replies (older ones were its brief).
    if (!(at(e) > row.created_at.getTime())) continue;
    const { rowCount } = await convo.pool.query(`select 1 from coworker_task_events where event_id = $1`, [e.id]);
    if (rowCount) continue;
    if (!checkedOpen) {
      const task = await soko.getTask(row.task_id);
      if (TERMINAL.has(task.status.toUpperCase())) {
        ignored.add(row.task_id);
        return;
      }
      checkedOpen = true;
    }
    // Claim, then act: a reply is acted on at most once, even across a crash.
    const claimed = await convo.pool.query(`insert into coworker_task_events (event_id, task_id) values ($1, $2) on conflict do nothing`, [e.id, row.task_id]);
    if (claimed.rowCount !== 1) continue;
    // Only the task's owner (the Sokosumi user who is billed) may steer it; other participants are ignored.
    if (e.actor?.id !== row.sokosumi_user_id) continue;
    await answered(convo, row.task_id, `reply:${e.id}`, () => handleReply(convo, ref, e.id, e.comment as string));
  }
}

const FALLBACK =
  "Something went wrong on my side while reading your message. Please send it again in a few minutes. " +
  "Reply with your OpenAPI link, or your base URL and example requests, one per line.";

/**
 * The task or event is claimed before it is handled, so an error must not leave it unanswered: the seller gets a
 * plain "send it again" under the same dedupe key (a no-op when the handler already answered). Only when even that
 * fails is the error thrown, for the loop to log.
 */
async function answered(convo: ConversationDeps, taskId: string, dedupeKey: string, handle: () => Promise<void>): Promise<void> {
  try {
    await handle();
  } catch (e) {
    console.error(`[sokosumi-inbox] ${dedupeKey} failed: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await enqueueMessage(convo.pool, { apiId: null, taskId, body: FALLBACK, taskStatus: "INPUT_REQUIRED", dedupeKey });
    } catch {
      throw e;
    }
  }
}
