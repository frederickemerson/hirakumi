import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayClient, PreviewResult } from "../src/gateway.js";
import type { StructuredCall } from "../src/llm/claude.js";
import { qaStep } from "../src/onboarding/qaStep.js";
import { INVALID_STRING } from "../src/qa/inputs.js";
import { getStep } from "../src/steps.js";
import { createTestDb, messagesFor, seedApi, seedOperation, type TestDb } from "./helpers/db.js";

let db: TestDb;
beforeAll(async () => (db = await createTestDb()));
afterAll(async () => db.close());

const json = (status: number, body: unknown): PreviewResult => ({ status, contentType: "application/json", body: JSON.stringify(body), latencyMs: 5 });
const gatewayFake = () => {
  const preview = vi.fn(async (_a: string, _o: string, i: Record<string, unknown>) =>
    i.symbol === INVALID_STRING ? json(404, { error: "unknown symbol" }) : json(200, { symbol: i.symbol, price: 0.31 }),
  );
  return { gateway: { preview } as GatewayClient, preview };
};
const llm = vi.fn().mockResolvedValue({
  rules: [{ opId: "getPrice", promise: "A response counts as good when it has the symbol and a numeric price." }],
  listing: { summary: "Live crypto prices", description: "Current prices for major tickers.", tags: ["crypto", "prices"] },
}) as unknown as StructuredCall;

describe("qaStep (ownership_verified → rule_built)", () => {
  it("saves rule, plain English and test inputs, then asks the seller to review", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    const opRowId = await seedOperation(db.pool, apiId);
    const { gateway, preview } = gatewayFake();
    expect(await qaStep({ pool: db.pool, gateway, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("ran");
    expect(preview).toHaveBeenCalledTimes(6);
    const { rows: [rule] } = await db.pool.query(`select version, hash, plain_english, definition from rules where operation_id = $1`, [opRowId]);
    expect(rule.version).toBe(1);
    expect(rule.hash).toMatch(/^sha256:/);
    expect(rule.plain_english).toBe("A response counts as good when it has the symbol and a numeric price.");
    const { rows: inputs } = await db.pool.query(`select input from test_inputs where operation_id = $1 order by input->>'symbol'`, [opRowId]);
    expect(inputs.map((r) => r.input)).toEqual([{ symbol: "ADA" }, { symbol: "BTC" }]);
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("rule_built");
    expect((await getStep(db.pool, apiId, "qa"))?.output).toMatchObject({ listing: { tags: ["crypto", "prices"] }, ops: [{ opId: "getPrice", calls: 6, badInput: "rejected" }] });
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toMatch(/^Test calls done: 6 calls .* Review the price and publish: https:\/\/web\.test\/apis\//);
  });

  it("re-running after a crash reuses saved rules instead of calling upstream again", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const first = gatewayFake();
    await qaStep({ pool: db.pool, gateway: first.gateway, llm, webBaseUrl: "https://web.test" }, apiId);
    await db.pool.query(`update apis set state = 'ownership_verified' where id = $1`, [apiId]);
    await db.pool.query(`update onboard_steps set status = 'running' where api_id = $1 and step = 'qa'`, [apiId]);
    const second = gatewayFake();
    await qaStep({ pool: db.pool, gateway: second.gateway, llm, webBaseUrl: "https://web.test" }, apiId);
    expect(second.preview).not.toHaveBeenCalled();
    expect((await db.pool.query(`select count(*)::int as n from rules r join operations o on o.id = r.operation_id where o.api_id = $1`, [apiId])).rows[0].n).toBe(1);
  });

  it("does not build a rule when a wrong request looks like a right one (rule too loose)", async () => {
    const apiId = await seedApi(db.pool, { state: "ownership_verified" });
    await seedOperation(db.pool, apiId);
    const preview = vi.fn(async () => json(200, { symbol: "ADA", price: 0.31 }));
    expect(await qaStep({ pool: db.pool, gateway: { preview } as GatewayClient, llm, webBaseUrl: "https://web.test" }, apiId)).toBe("failed");
    expect((await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state).toBe("ownership_verified");
    expect((await messagesFor(db.pool, apiId)).at(-1)?.body).toMatch(/can't tell them apart/);
  });
});
