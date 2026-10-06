import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermanentError } from "../src/errors.js";
import { enqueueMessage } from "../src/messages.js";
import { backoffMs, getStep, isDue, MAX_ATTEMPTS, runStep } from "../src/steps.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());
const later = (ms: number) => new Date(Date.now() + ms);

describe("enqueueMessage", () => {
  it("copies the API's Sokosumi task id and ignores a repeated dedupe key", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_42" });
    expect(await enqueueMessage(db.pool, { apiId, body: "a", taskStatus: "RUNNING", dedupeKey: `k:${apiId}` })).toBe(true);
    expect(await enqueueMessage(db.pool, { apiId, body: "a again", dedupeKey: `k:${apiId}` })).toBe(false);
    expect(await messagesFor(db.pool, apiId)).toEqual([{ body: "a", task_status: "RUNNING", task_id: "tsk_42", dedupe_key: `k:${apiId}` }]);
  });
});

describe("isDue", () => {
  it("backs off pending steps exponentially and re-runs interrupted ones", () => {
    const t = new Date("2026-10-07T00:00:00Z");
    expect(isDue(null, t)).toBe(true);
    expect(isDue({ status: "pending", attempts: 2, output: null, updated_at: t }, new Date(t.getTime() + backoffMs(2) - 1))).toBe(false);
    expect(isDue({ status: "pending", attempts: 2, output: null, updated_at: t }, new Date(t.getTime() + backoffMs(2)))).toBe(true);
    expect(isDue({ status: "running", attempts: 1, output: null, updated_at: t }, t)).toBe(true);
    expect(isDue({ status: "done", attempts: 1, output: null, updated_at: t }, t)).toBe(false);
    expect(isDue({ status: "failed", attempts: 3, output: null, updated_at: t }, t)).toBe(false);
  });
});

describe("runStep", () => {
  it("retries a transient error and gives up after MAX_ATTEMPTS with exactly one seller message", async () => {
    const apiId = await seedApi(db.pool);
    const body = vi.fn().mockRejectedValue(new Error("upstream timeout"));
    const outcomes = [];
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) outcomes.push(await runStep(db.pool, apiId, "parse", body, later(3_600_000)));
    expect(outcomes).toEqual(["retry", "retry", "failed", "skipped"]);
    expect(body).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const step = await getStep(db.pool, apiId, "parse");
    expect(step).toMatchObject({ status: "failed", attempts: 3, output: { error: "upstream timeout" } });
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ task_status: "INPUT_REQUIRED" });
    expect(msgs[0].body).toMatch(/reading your OpenAPI file.*3 tries.*upstream timeout/);
  });

  it("stops at once on a PermanentError and shows its text to the seller", async () => {
    const apiId = await seedApi(db.pool);
    const outcome = await runStep(db.pool, apiId, "parse", async () => {
      throw new PermanentError("This is a Swagger 2.0 file.");
    });
    expect(outcome).toBe("failed");
    expect((await messagesFor(db.pool, apiId))[0].body).toBe('I had to stop at "reading your OpenAPI file": This is a Swagger 2.0 file.');
  });

  it("bails out cleanly when the API was deleted before the step starts (audit M2)", async () => {
    const body = vi.fn();
    expect(await runStep(db.pool, "api_deleted", "qa", body)).toBe("gone");
    expect(body).not.toHaveBeenCalled();
    const { rows } = await db.pool.query(`select 1 from onboard_steps where api_id = 'api_deleted'`);
    expect(rows).toEqual([]);
  });

  it("bails out cleanly when the API is deleted while the step runs: no error, no message (audit M2)", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "task_m2" });
    const outcome = await runStep(db.pool, apiId, "qa", async () => {
      // The seller deletes the API mid-step (the web's delete removes these rows in one transaction).
      await db.pool.query(`delete from onboard_steps where api_id = $1`, [apiId]);
      await db.pool.query(`delete from apis where id = $1`, [apiId]);
      const { rows: [api] } = await db.pool.query<{ name: string }>(`select name from apis where id = $1`, [apiId]);
      api.name.trim(); // what qaStep did with the missing row: a TypeError
    });
    expect(outcome).toBe("gone");
    const { rows } = await db.pool.query(`select 1 from messages where task_id = 'task_m2'`);
    expect(rows).toEqual([]);
  });
});
