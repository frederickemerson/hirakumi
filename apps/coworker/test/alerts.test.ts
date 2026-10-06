import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processHealthEvents } from "../src/alerts.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

async function probe(apiId: string, id: string, verdict: string, at: string) {
  await db.pool.query(
    `insert into calls (id, kind, api_id, op_id, execution, verdict, created_at) values ($1, 'probe', $2, 'getPrice', 'upstream_ok', $3, $4)`,
    [id, apiId, verdict, at],
  );
}

describe("processHealthEvents", () => {
  it("names the failing field and the first failure time, exactly once", async () => {
    const apiId = await seedApi(db.pool, { state: "live", sokosumiTaskId: "tsk_h" });
    await probe(apiId, `c1_${apiId}`, "pass", "2026-10-07T10:00:00Z");
    await probe(apiId, `c2_${apiId}`, "fail", "2026-10-07T10:00:10Z");
    await probe(apiId, `c3_${apiId}`, "fail", "2026-10-07T10:00:20Z");
    await db.pool.query(
      `insert into health_events (api_id, from_health, to_health, reasons, at) values ($1, 'healthy', 'down', $2::jsonb, '2026-10-07T10:00:20Z')`,
      [apiId, JSON.stringify([{ op: "getPrice", reason: "/price must be number", since: "2026-10-07T10:00:10Z" }])], // contract D5 shape
    );
    expect(await processHealthEvents(db.pool, "https://web.test")).toBe(1);
    expect(await processHealthEvents(db.pool, "https://web.test")).toBe(0);
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].task_id).toBe("tsk_h");
    expect(msgs[0].body).toContain("Failing check: getPrice: /price must be number. First failed test: 2026-10-07 10:00:10 UTC.");
  });

  it("announces recovery", async () => {
    const apiId = await seedApi(db.pool, { state: "live" });
    await db.pool.query(`insert into health_events (api_id, from_health, to_health, at) values ($1, 'down', 'healthy', '2026-10-07T10:05:00Z')`, [apiId]);
    await processHealthEvents(db.pool, "https://web.test");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/is Live again \(recovered at 2026-10-07 10:05:00 UTC\)/);
  });
});
