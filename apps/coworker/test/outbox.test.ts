import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueMessage } from "../src/messages.js";
import { SokosumiHttpError, type SokosumiClient } from "../src/sokosumi/client.js";
import { deliverMessages } from "../src/sokosumi/outbox.js";
import { reportOnboardingUsage } from "../src/sokosumi/usage.js";
import { createTestDb, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const soko = (createTaskEvent: SokosumiClient["createTaskEvent"]) =>
  ({ me: vi.fn(), listEvents: vi.fn(), getTask: vi.fn(), createTaskEvent: vi.fn(createTaskEvent), reportUsage: vi.fn().mockResolvedValue({ id: "ous_1" }) }) satisfies SokosumiClient;

describe("deliverMessages", () => {
  it("posts in order, falls back to comment-only on an invalid status transition, skips dashboard-only rows", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_a" });
    const dashOnly = await seedApi(db.pool);
    await enqueueMessage(db.pool, { apiId, body: "one", taskStatus: "RUNNING", dedupeKey: `1:${apiId}` });
    await enqueueMessage(db.pool, { apiId, body: "two", taskStatus: "COMPLETED", dedupeKey: `2:${apiId}` });
    await enqueueMessage(db.pool, { apiId: dashOnly, body: "dash", dedupeKey: `3:${dashOnly}` });
    const client = soko(async (_t, body) => {
      if (body.status === "COMPLETED") throw new SokosumiHttpError("Invalid status transition", 409);
      return { id: "evt" };
    });
    expect(await deliverMessages(db.pool, client)).toBe(2);
    expect(client.createTaskEvent.mock.calls.map((c) => c[1])).toEqual([
      { comment: "one", status: "RUNNING" },
      { comment: "two", status: "COMPLETED" },
      { comment: "two" },
    ]);
    expect(await deliverMessages(db.pool, client)).toBe(0);
    const { rows } = await db.pool.query(`select delivered_at is not null as delivered from messages where api_id = $1`, [dashOnly]);
    expect(rows).toEqual([{ delivered: false }]);
  });

  it("records the error and holds back later messages of the same task", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_b" });
    await enqueueMessage(db.pool, { apiId, body: "first", dedupeKey: `f:${apiId}` });
    await enqueueMessage(db.pool, { apiId, body: "second", dedupeKey: `s:${apiId}` });
    const client = soko(async () => {
      throw new Error("ECONNRESET");
    });
    await deliverMessages(db.pool, client);
    expect(client.createTaskEvent).toHaveBeenCalledTimes(1);
    const { rows } = await db.pool.query(`select body, delivery_attempts, last_error from messages where api_id = $1 order by id`, [apiId]);
    expect(rows).toEqual([
      { body: "first", delivery_attempts: 1, last_error: "ECONNRESET" },
      { body: "second", delivery_attempts: 0, last_error: null },
    ]);
  });
});

describe("reportOnboardingUsage", () => {
  it("bills once per task after its API is Live, with a stable idempotency key", async () => {
    const apiId = await seedApi(db.pool, { state: "live", sokosumiTaskId: "tsk_bill" });
    await db.pool.query(`insert into coworker_tasks (task_id, sokosumi_user_id, sokosumi_organization_id, task_name, setup_token) values ('tsk_bill', 'user_7', null, 'n', 'tok_bill')`);
    const client = soko(async () => ({ id: "x" }));
    expect(await reportOnboardingUsage(db.pool, client, 1500)).toBe(1);
    expect(await reportOnboardingUsage(db.pool, client, 1500)).toBe(0);
    expect(client.reportUsage).toHaveBeenCalledWith({ userId: "user_7", organizationId: null, idempotencyKey: "usage:tsk_bill:onboarding", credits: 1500, referenceId: apiId });
  });
});
