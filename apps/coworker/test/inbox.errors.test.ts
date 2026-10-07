import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SokosumiClient, SokosumiEvent } from "../src/sokosumi/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";

// The handlers throw (a bug or a database hiccup) after the inbox has claimed the task or event.
vi.mock("../src/sokosumi/conversation.js", () => ({
  handleBrief: vi.fn().mockRejectedValue(new Error("boom")),
  handleReply: vi.fn().mockRejectedValue(new Error("boom")),
}));
const { createInbox } = await import("../src/sokosumi/inbox.js");

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const rand = () => Math.random().toString(36).slice(2, 10);

describe("Sokosumi inbox when handling throws", () => {
  it("still answers the brief and each claimed reply, once", async () => {
    const taskId = `tsk_${rand()}`;
    let events: SokosumiEvent[] = [{ id: `evt_${rand()}`, taskId, createdAt: "2020-01-01T00:00:00.000Z", actor: { type: "user", id: "user_1" } }];
    const soko = {
      me: vi.fn(),
      listEvents: vi.fn(async () => ({ events, nextCursor: null })),
      getTask: vi.fn(async (id: string) => ({ id, name: "Sell my API", userId: "user_1", organizationId: null, status: "READY" })),
      createTaskEvent: vi.fn(),
      reportUsage: vi.fn(),
    } satisfies SokosumiClient;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: "https://web.test", fetchSpec: vi.fn() });
    expect(await inbox.poll()).toBe(1);
    events = [{ id: `evt_${rand()}`, taskId, createdAt: new Date(Date.now() + 60_000).toISOString(), comment: "https://api.example.com/v3/api-docs", actor: { type: "user", id: "user_1" } }];
    await inbox.poll();
    await inbox.poll();
    const { rows } = await db.pool.query<{ body: string; task_status: string }>(`select body, task_status from messages where task_id = $1 order by id`, [taskId]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.body).toMatch(/^Something went wrong on my side while reading your message\. Please send it again in a few minutes\./);
      expect(r.task_status).toBe("INPUT_REQUIRED");
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    error.mockRestore();
  });

  it("one task the API refuses (deleted, forbidden) doesn't stop the others", async () => {
    const bad = `tsk_${rand()}`;
    const good = `tsk_${rand()}`;
    const events: SokosumiEvent[] = [
      { id: `evt_${rand()}`, taskId: bad, createdAt: "2020-01-01T00:00:00.000Z", actor: { type: "user", id: "user_1" } },
      { id: `evt_${rand()}`, taskId: good, createdAt: "2020-01-01T00:00:00.000Z", actor: { type: "user", id: "user_1" } },
    ];
    const soko = {
      me: vi.fn(),
      listEvents: vi.fn(async () => ({ events, nextCursor: null })),
      getTask: vi.fn(async (id: string) => {
        if (id === bad) throw new Error("Sokosumi answered 404");
        return { id, name: "Sell my API", userId: "user_1", organizationId: null, status: "READY" };
      }),
      createTaskEvent: vi.fn(),
      reportUsage: vi.fn(),
    } satisfies SokosumiClient;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const inbox = createInbox({ pool: db.pool, soko, webBaseUrl: "https://web.test", fetchSpec: vi.fn() });
    expect(await inbox.poll()).toBe(1);
    const { rows } = await db.pool.query(`select task_id from coworker_tasks where task_id = any($1)`, [[bad, good]]);
    expect(rows.map((r) => r.task_id)).toEqual([good]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(bad), expect.anything());
    error.mockRestore();
  });
});
