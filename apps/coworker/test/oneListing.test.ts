import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStep } from "../src/onboarding/parseStep.js";
import { registerStep } from "../src/onboarding/registerStep.js";
import { getStep } from "../src/steps.js";
import { PRICE_SPEC } from "./fixtures.js";
import { createTestDb, messagesFor, seedApi, type TestDb } from "./helpers/db.js";

const TAKEN = "This API is already listed by another account. If it's yours, retire that listing first.";

let db: TestDb;
beforeEach(async () => (db = await createTestDb()));
afterEach(async () => db.close());

const withServers = (url: string) => JSON.stringify({ ...JSON.parse(PRICE_SPEC), servers: [{ url }] });
const stateOf = async (apiId: string) => (await db.pool.query(`select state from apis where id = $1`, [apiId])).rows[0].state;

describe("one API, one listing: the parse step tells the seller as soon as it learns the base", () => {
  it("stops with a task comment when another account lists an overlapping base", async () => {
    await seedApi(db.pool, { state: "live", pathPrefix: "/v1", name: "Secret Prices" });
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_dup" });
    const r = await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers("https://price.example.dev/v1/prices")) }, apiId);
    expect(r).toBe("failed");
    expect(await stateOf(apiId)).toBe("intake");
    const msgs = await messagesFor(db.pool, apiId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ task_id: "tsk_dup", task_status: "INPUT_REQUIRED" });
    expect(msgs[0].body).toBe(`Step 1 of 7, Read your file: I had to stop at "reading your API": ${TAKEN}`);
    expect(msgs[0].body).not.toMatch(/Secret Prices/);
  });

  it("goes on when the other listing is retired, on another folder (/v1 vs /v10), or the seller's own", async () => {
    const retired = await seedApi(db.pool, { state: "retired", pathPrefix: "/" });
    expect(retired).toBeTruthy();
    await seedApi(db.pool, { state: "live", pathPrefix: "/v1" });
    const apiId = await seedApi(db.pool);
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers("https://price.example.dev/v10")) }, apiId)).toBe("ran");

    const mine = (await db.pool.query(`select seller_id from apis where id = $1`, [apiId])).rows[0].seller_id as string;
    await seedApi(db.pool, { state: "live", pathPrefix: "/v2", sellerId: mine });
    const second = await seedApi(db.pool, { sellerId: mine });
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers("https://price.example.dev/v2/prices")) }, second)).toBe("ran");
  });
});

describe("one API, one listing: a blocked duplicate never reaches the registry", () => {
  it("the database refuses to move a duplicate base into registering, so registerAgent is never called", async () => {
    await seedApi(db.pool, { state: "live", pathPrefix: "/" });
    const dup = await seedApi(db.pool, { state: "endpoints_confirmed", pathPrefix: "/" });
    await expect(db.pool.query(`update apis set state = 'registering' where id = $1`, [dup])).rejects.toThrow(/apis_active_base_uniq/);
    const masumi = { registerAgent: vi.fn(), getAgentIdentifier: vi.fn(), getRegistryStatus: vi.fn() };
    await registerStep({
      pool: db.pool, masumi,
      masumiConfig: { baseUrl: "http://payment-service:3001/api/v1", token: "t", network: "Preprod", registryToken: "rt" },
      publicBaseUrl: "https://api.hirakumi.app", webBaseUrl: "https://web.test", escrowUnit: "unit",
    }, dup);
    expect(masumi.registerAgent).not.toHaveBeenCalled();
    expect(await stateOf(dup)).toBe("endpoints_confirmed");
    expect((await getStep(db.pool, dup, "register"))?.status).not.toBe("done");
  });
});
