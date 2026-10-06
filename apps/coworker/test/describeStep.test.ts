import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StructuredCall } from "../src/llm/claude.js";
import { describeStep } from "../src/onboarding/describeStep.js";
import { parseStep } from "../src/onboarding/parseStep.js";
import { PRICE_SPEC } from "./fixtures.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

describe("describeStep (parsed → described)", () => {
  it("makes ONE Claude call, stores descriptions and flags, and tells the seller how many look sellable", async () => {
    const apiId = await seedApi(db.pool);
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(PRICE_SPEC) }, apiId);
    const llm = vi.fn().mockResolvedValue({
      operations: [
        { opId: "getPrice", description: "Latest price for a ticker.", sideEffectsLikely: false },
        { opId: "get_history_symbol", description: "Daily price history.", sideEffectsLikely: false },
        { opId: "createAlert", description: "Creates an alert.", sideEffectsLikely: false },
      ],
    }) as unknown as StructuredCall & ReturnType<typeof vi.fn>;
    expect(await describeStep({ pool: db.pool, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("ran");
    expect(llm).toHaveBeenCalledTimes(1);
    const { rows } = await db.pool.query(`select op_id, description, side_effects_likely from operations where api_id = $1 order by op_id collate "C"`, [apiId]);
    expect(rows).toEqual([
      { op_id: "createAlert", description: "Creates an alert.", side_effects_likely: true },
      { op_id: "getPrice", description: "Latest price for a ticker.", side_effects_likely: false },
      { op_id: "get_history_symbol", description: "Daily price history.", side_effects_likely: false },
    ]);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("described");
    const last = (await messagesFor(db.pool, apiId)).at(-1);
    expect(last).toMatchObject({ task_status: "INPUT_REQUIRED" });
    expect(last?.body).toBe(`Found 3 endpoints; 2 look sellable (read-only). Pick the ones to sell and confirm they have no side effects: https://web.test/apis/${apiId}`);
  });
});
