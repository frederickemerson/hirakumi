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

describe("parseStep for an API that needs a key", () => {
  const KEYED = JSON.stringify({
    ...JSON.parse(PRICE_SPEC),
    security: [{ key: [] }],
    components: { ...JSON.parse(PRICE_SPEC).components, securitySchemes: { key: { type: "apiKey", in: "header", name: "X-API-Key" } } },
  });

  it("saves where the key goes and tells the seller to add it on the ownership page, not in a comment", async () => {
    const apiId = await seedApi(db.pool, { sokosumiTaskId: "tsk_key" });
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(KEYED) }, apiId)).toBe("ran");
    const step = await getStep(db.pool, apiId, "parse");
    expect(step?.output?.authHint).toEqual({ in: "header", name: "X-API-Key" });
    const [m] = await messagesFor(db.pool, apiId);
    expect(m.body).toMatch(/found 4 endpoints\. I skipped 2/);
    expect(m.body).toContain("Your API needs a key (the X-API-Key header). Add it on the ownership page before you prove ownership. Never paste it in a comment.");
  });

  it("saves a null hint when no endpoint needs a key", async () => {
    const apiId = await seedApi(db.pool);
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(PRICE_SPEC) }, apiId);
    expect((await getStep(db.pool, apiId, "parse"))?.output?.authHint).toBeNull();
    expect((await messagesFor(db.pool, apiId))[0].body).not.toMatch(/key/);
  });
});

describe("parseStep honours servers[0].url (review I7)", () => {
  const withServers = (servers: unknown) => JSON.stringify({ ...JSON.parse(PRICE_SPEC), servers });
  const prefixOf = async (apiId: string) => (await db.pool.query(`select path_prefix, state from apis where id = $1`, [apiId])).rows[0];
  it("stores a same-host server path as the path prefix", async () => {
    const apiId = await seedApi(db.pool, {});
    const { rows: [a] } = await db.pool.query(`select origin from apis where id = $1`, [apiId]);
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: `${a.origin}/v1/` }])) }, apiId);
    expect(await prefixOf(apiId)).toEqual({ path_prefix: "/v1", state: "parsed" });
  });
  it("resolves a relative server URL against the OpenAPI file's location", async () => {
    const apiId = await seedApi(db.pool, {});
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "/api/v2" }])) }, apiId);
    expect((await prefixOf(apiId)).path_prefix).toBe("/api/v2");
  });
  it("keeps the root when there is no servers list", async () => {
    const apiId = await seedApi(db.pool, {});
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(PRICE_SPEC) }, apiId);
    expect((await prefixOf(apiId)).path_prefix).toBe("/");
  });
  it("accepts a base path under the OpenAPI file's folder", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://price.example.dev/team-a/openapi.json" });
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "v1" }])) }, apiId);
    expect(await prefixOf(apiId)).toEqual({ path_prefix: "/team-a/v1", state: "parsed" });
  });
  it("refuses a base path outside the OpenAPI file's folder (the code in that file only covers its folder)", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://price.example.dev/team-a/openapi.json" });
    const r = await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "/team-b" }])) }, apiId);
    expect(r).toBe("failed");
    expect((await getStep(db.pool, apiId, "parse"))?.output?.error).toMatch(/only prove ownership of APIs under \/team-a\//);
    expect((await prefixOf(apiId)).state).toBe("intake");
  });
  it("refuses a file in a folder whose API has no servers (the API would be the whole host)", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://price.example.dev/team-a/openapi.json" });
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(PRICE_SPEC) }, apiId)).toBe("failed");
  });
  it("refuses an API that runs on a different host than its OpenAPI file (ownership covers the file's host only)", async () => {
    const apiId = await seedApi(db.pool, {});
    const r = await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "https://other-host.example/v1" }])) }, apiId);
    expect(r).toBe("failed");
    expect((await getStep(db.pool, apiId, "parse"))?.output?.error).toMatch(/other-host\.example/);
    expect((await prefixOf(apiId)).state).toBe("intake");
  });
});
