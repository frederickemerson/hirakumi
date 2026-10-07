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

describe("the wallet line on comments that link to an API's pages", () => {
  const WEB = "https://hirakumi.vercel.app";
  const ok = () => soko(async () => ({ id: "evt" }));
  async function linkedApi(taskId: string, state = "described") {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: taskId, state });
    await db.pool.query(`update sellers set sokosumi_user_id = $2 from apis where apis.id = $1 and sellers.id = apis.seller_id`, [apiId, `user_${taskId}`]);
    const { rows: [s] } = await db.pool.query<{ cardano_addr: string }>(`select s.cardano_addr from apis a join sellers s on s.id = a.seller_id where a.id = $1`, [apiId]);
    return { apiId, tail: s.cardano_addr.slice(-6) };
  }

  it.each(["ownership", "review", "overview", "endpoints", ""])("adds the owner's wallet once to a /apis/<id>/%s link", async (page) => {
    const taskId = `tsk_w_${page || "root"}`;
    const { apiId, tail } = await linkedApi(taskId);
    const link = `${WEB}/apis/${apiId}${page ? `/${page}` : ""}`;
    await enqueueMessage(db.pool, { apiId, body: `Approve it here: ${link} Then see ${WEB}/apis/${apiId}/review.`, dedupeKey: `w:${apiId}` });
    const client = ok();
    await deliverMessages(db.pool, client, WEB);
    const comment = client.createTaskEvent.mock.calls.find((c) => c[0] === taskId)![1].comment as string;
    expect(comment).toBe(`Approve it here: ${link} Then see ${WEB}/apis/${apiId}/review.\n\nOpen it signed in with the wallet ending \`…${tail}\`. (Different wallet? Reply \`link wallet\`.)`);
    expect(comment.match(/link wallet/g)).toHaveLength(1);
    expect(comment).not.toMatch(/[–—]/);
    const { rows: [m] } = await db.pool.query(`select body from messages where api_id = $1`, [apiId]);
    expect(m.body).not.toContain("wallet ending");
  });

  it("names the wallet only when the comment already offers `link wallet` (help text)", async () => {
    const { apiId, tail } = await linkedApi("tsk_w_help");
    await enqueueMessage(db.pool, { apiId, body: `Publish: ${WEB}/apis/${apiId}/review\nUsing a different wallet? Reply \`link wallet\`.`, dedupeKey: `h:${apiId}` });
    const client = ok();
    await deliverMessages(db.pool, client, WEB);
    const comment = client.createTaskEvent.mock.calls.find((c) => c[0] === "tsk_w_help")![1].comment as string;
    expect(comment.endsWith(`Open it signed in with the wallet ending \`…${tail}\`.`)).toBe(true);
    expect(comment.match(/link wallet/g)).toHaveLength(1);
  });

  it("leaves other comments alone: no API page link, public pages, other hosts, unlinked sellers", async () => {
    const { apiId } = await linkedApi("tsk_w_none");
    const unlinked = await seedApi(db.pool, { sokosumiTaskId: "tsk_w_unl" });
    const bodies = [
      "Reading your file now.",
      `Public page: ${WEB}/p/${apiId}`,
      `Setup: ${WEB}/setup?t=abc`,
      `Elsewhere: https://other.example/apis/${apiId}/review`,
    ];
    for (const [i, body] of bodies.entries()) await enqueueMessage(db.pool, { apiId, body, dedupeKey: `n${i}:${apiId}` });
    await enqueueMessage(db.pool, { apiId: unlinked, body: `Review: ${WEB}/apis/${unlinked}/review`, dedupeKey: `u:${unlinked}` });
    const client = ok();
    await deliverMessages(db.pool, client, WEB);
    expect(client.createTaskEvent.mock.calls.filter((c) => c[0].startsWith("tsk_w_")).map((c) => c[1].comment)).toEqual([...bodies, `Review: ${WEB}/apis/${unlinked}/review`]);
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
  it("one row the API keeps refusing doesn't stop the others from being billed", async () => {
    const badApi = await seedApi(db.pool, { state: "live", sokosumiTaskId: "tsk_bill_bad" });
    const goodApi = await seedApi(db.pool, { state: "live", sokosumiTaskId: "tsk_bill_good" });
    await db.pool.query(`insert into coworker_tasks (task_id, sokosumi_user_id, sokosumi_organization_id, task_name, setup_token) values ('tsk_bill_bad', 'user_bad', null, 'n', 'tok_bad'), ('tsk_bill_good', 'user_good', null, 'n', 'tok_good')`);
    const client = soko(async () => ({ id: "x" }));
    client.reportUsage.mockImplementation(async (u: { userId: string }) => {
      if (u.userId === "user_bad") throw new Error("Sokosumi answered 422");
      return { id: "ous_2" };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reportOnboardingUsage(db.pool, client, 1500)).toBe(1);
    error.mockRestore();
    const { rows } = await db.pool.query(`select task_id from coworker_tasks where usage_reported_at is not null and task_id like 'tsk_bill_%' order by task_id`);
    expect(rows.map((r) => r.task_id)).toEqual(["tsk_bill_good"]);
    void badApi; void goodApi;
  });
});
