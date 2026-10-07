import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SokosumiClient } from "../src/sokosumi/client.js";
import { createInbox } from "../src/sokosumi/inbox.js";
import { createTestDb, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

function fakeSoko(events: unknown[], taskStatus = "READY") {
  return {
    me: vi.fn(),
    listEvents: vi.fn().mockResolvedValue({ events, nextCursor: null }),
    getTask: vi.fn(async (id: string) => ({ id, name: "Put my API on the agent market", userId: "user_1", organizationId: "org_1", status: taskStatus })),
    createTaskEvent: vi.fn(),
    reportUsage: vi.fn(),
  } satisfies SokosumiClient;
}

describe("Sokosumi inbox", () => {
  it("records a newly assigned task once and asks for the link here, with no web page to open", async () => {
    const soko = fakeSoko([
      { id: "evt_1", taskId: "tsk_new", createdAt: "t", status: "READY", actor: { type: "user", id: "user_1" } },
      { id: "evt_2", taskId: "tsk_new", createdAt: "t", comment: "please", actor: { type: "user", id: "user_1" } },
      { id: "evt_3", taskId: "tsk_mine", createdAt: "t", status: "RUNNING", actor: { type: "coworker", id: "cow_1" } },
    ]);
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: "https://web.test" });
    expect(await inbox.poll()).toBe(1);
    expect(await inbox.poll()).toBe(0);
    expect(soko.getTask).toHaveBeenCalledTimes(1);
    const { rows: [task] } = await db.pool.query(`select sokosumi_user_id, sokosumi_organization_id, setup_token from coworker_tasks where task_id = 'tsk_new'`);
    expect(task).toMatchObject({ sokosumi_user_id: "user_1", sokosumi_organization_id: "org_1" });
    const { rows: msgs } = await db.pool.query(`select body, task_status from messages where task_id = 'tsk_new'`);
    expect(msgs).toEqual([{ body: expect.stringContaining("Reply with the https link to your OpenAPI file"), task_status: "INPUT_REQUIRED" }]);
    expect(msgs[0].body).not.toContain("https://web.test");
    expect(task.setup_token).toBeTruthy();
  });

  it("ignores tasks that are already finished", async () => {
    const soko = fakeSoko([{ id: "evt_9", taskId: "tsk_done", createdAt: "t", actor: { type: "user", id: "u" } }], "COMPLETED");
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: "https://web.test" });
    expect(await inbox.poll()).toBe(0);
    expect(await inbox.poll()).toBe(0);
    expect(soko.getTask).toHaveBeenCalledTimes(1);
  });
});
