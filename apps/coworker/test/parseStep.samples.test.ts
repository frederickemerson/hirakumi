import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseStep } from "../src/onboarding/parseStep.js";
import { buildGoodInputs } from "../src/qa/inputs.js";
import { getStep } from "../src/steps.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

async function seedSamplesApi(base: string, lines: string, proofUrl: string): Promise<string> {
  const apiId = await seedApi(db.pool, { openapiUrl: proofUrl });
  await db.pool.query(`update apis set intake_kind = 'samples', samples = $2::jsonb where id = $1`, [apiId, JSON.stringify({ base, lines })]);
  return apiId;
}

describe("parseStep for an API without an OpenAPI file (example requests)", () => {
  it("builds the operations from the example requests, never fetches, and sets the base path", async () => {
    const apiId = await seedSamplesApi(
      "https://price.example.dev/v1",
      "GET /price?symbol=ADA\nGET /price?symbol=BTC\nGET /coins/{id=cardano}/history?days?=7",
      "https://price.example.dev/v1/hirakumi-verify.json",
    );
    const fetchSpec = vi.fn();
    expect(await parseStep({ pool: db.pool, fetchSpec }, apiId)).toBe("ran");
    expect(fetchSpec).not.toHaveBeenCalled();
    const { rows: [api] } = await db.pool.query(`select state, path_prefix from apis where id = $1`, [apiId]);
    expect(api).toEqual({ state: "parsed", path_prefix: "/v1" });
    const { rows: ops } = await db.pool.query(`select op_id, method, path, input_schema from operations where api_id = $1 order by path`, [apiId]);
    expect(ops.map((o) => [o.method, o.path])).toEqual([["GET", "/coins/{id}/history"], ["GET", "/price"]]);
    // The example values become the test calls.
    const price = ops.find((o) => o.path === "/price")!;
    expect(buildGoodInputs(price.input_schema, [], price.op_id)).toEqual([{ symbol: "ADA" }, { symbol: "BTC" }]);
    const history = ops.find((o) => o.path === "/coins/{id}/history")!;
    expect(history.input_schema.required).toEqual(["id"]);
    expect(buildGoodInputs(history.input_schema, [], history.op_id)).toEqual([{ id: "cardano", days: 7 }]);
    expect((await getStep(db.pool, apiId, "parse"))?.status).toBe("done");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/I read your example requests and found 2 endpoints/);
  });

  it("refuses a proof file outside the base folder (folder binding unchanged)", async () => {
    const apiId = await seedSamplesApi("https://price.example.dev/v1", "GET /price?symbol=ADA", "https://price.example.dev/v2/hirakumi-verify.json");
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn() }, apiId)).toBe("failed");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/only prove ownership of APIs under \/v2\//);
  });

  it("explains bad example requests and does not retry", async () => {
    const apiId = await seedSamplesApi("https://price.example.dev", "GET /a/../b", "https://price.example.dev/hirakumi-verify.json");
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn() }, apiId)).toBe("failed");
    expect((await messagesFor(db.pool, apiId))[0].body).toMatch(/example requests could not be read\. Line 1: .*dot segment/);
  });
});
