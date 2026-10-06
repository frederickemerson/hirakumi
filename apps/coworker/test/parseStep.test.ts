import { sha256Hex } from "@hirakumi/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseStep } from "../src/onboarding/parseStep.js";
import { getStep } from "../src/steps.js";
import { PRICE_SPEC } from "./fixtures.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

describe("parseStep (intake → parsed)", () => {
  it("inserts disabled operations, saves the LLM context and advances the state once", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_1" });
    const fetchSpec = vi.fn().mockResolvedValue(PRICE_SPEC);
    expect(await parseStep({ pool: db.pool, fetchSpec }, apiId)).toBe("ran");
    const { rows: ops } = await db.pool.query(`select op_id, method, enabled, side_effects_likely from operations where api_id = $1 order by op_id collate "C"`, [apiId]);
    expect(ops).toEqual([
      { op_id: "createAlert", method: "POST", enabled: false, side_effects_likely: false },
      { op_id: "getPrice", method: "GET", enabled: false, side_effects_likely: false },
      { op_id: "get_history_symbol", method: "GET", enabled: false, side_effects_likely: false },
    ]);
    const { rows: [api] } = await db.pool.query(`select state, openapi_sha256 from apis where id = $1`, [apiId]);
    expect(api).toEqual({ state: "parsed", openapi_sha256: sha256Hex(PRICE_SPEC) });
    const step = await getStep(db.pool, apiId, "parse");
    expect(step?.status).toBe("done");
    expect((step?.output?.ops as unknown[]).length).toBe(3);
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ task_status: "RUNNING", task_id: "tsk_1" });
    expect(msgs[0].body).toMatch(/found 3 endpoints\. I skipped 3/);
  });

  it("does not overwrite a state someone else already changed (compare-and-set)", async () => {
    const apiId = await seedApi(db.pool, { state: "intake" });
    const fetchSpec = vi.fn(async () => {
      await db.pool.query(`update apis set state = 'retired' where id = $1`, [apiId]);
      return PRICE_SPEC;
    });
    await parseStep({ pool: db.pool, fetchSpec }, apiId);
    const { rows: [api] } = await db.pool.query(`select state from apis where id = $1`, [apiId]);
    expect(api.state).toBe("retired");
    expect((await db.pool.query(`select 1 from operations where api_id = $1`, [apiId])).rowCount).toBe(0);
  });

  it("explains an unparseable spec to the seller and does not retry it", async () => {
    const apiId = await seedApi(db.pool);
    const fetchSpec = vi.fn().mockResolvedValue("openapi: 3.0.3\ninfo:\n  title: [x\n");
    expect(await parseStep({ pool: db.pool, fetchSpec }, apiId)).toBe("failed");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/could not be read: .*line \d+/);
  });
});
