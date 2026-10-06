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
  const baseOf = async (apiId: string) => (await db.pool.query(`select origin, path_prefix, state from apis where id = $1`, [apiId])).rows[0];
  const errorOf = async (apiId: string) => (await getStep(db.pool, apiId, "parse"))?.output?.error as string;
  it("stores a same-host server path as the path prefix", async () => {
    const apiId = await seedApi(db.pool, {});
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "https://price.example.dev/v1/" }])) }, apiId);
    expect(await baseOf(apiId)).toEqual({ origin: "https://price.example.dev", path_prefix: "/v1", state: "parsed" });
  });
  it("resolves a relative server URL against the OpenAPI file's location", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://price.example.dev/team-a/openapi.json" });
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "v1" }])) }, apiId);
    expect(await baseOf(apiId)).toEqual({ origin: "https://price.example.dev", path_prefix: "/team-a/v1", state: "parsed" });
  });
  it("uses the OpenAPI file's origin and the root when there is no servers list, wherever the file is", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://docs.example.org/specs/openapi.json" });
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(PRICE_SPEC) }, apiId);
    expect(await baseOf(apiId)).toEqual({ origin: "https://docs.example.org", path_prefix: "/", state: "parsed" });
  });
  it("takes the API's origin from an absolute servers URL when the file is on GitHub (the file is not the proof)", async () => {
    const apiId = await seedApi(db.pool, { openapiUrl: "https://raw.githubusercontent.com/acme/price/main/openapi.json" });
    const fetchSpec = vi.fn().mockResolvedValue(withServers([{ url: "https://api.acme.dev/v2" }]));
    expect(await parseStep({ pool: db.pool, fetchSpec }, apiId)).toBe("ran");
    expect(fetchSpec).toHaveBeenCalledWith("https://raw.githubusercontent.com/acme/price/main/openapi.json");
    expect(await baseOf(apiId)).toEqual({ origin: "https://api.acme.dev", path_prefix: "/v2", state: "parsed" });
  });
  it("names an API that was named after its file host after the API's own host instead", async () => {
    const link = "https://raw.githubusercontent.com/acme/price/main/openapi.json";
    const fetchSpec = vi.fn().mockResolvedValue(withServers([{ url: "https://api.acme.dev/v2" }]));
    const unnamed = await seedApi(db.pool, { openapiUrl: link, name: "raw.githubusercontent.com" });
    await parseStep({ pool: db.pool, fetchSpec }, unnamed);
    const nameOf = async (apiId: string) => (await db.pool.query(`select name from apis where id = $1`, [apiId])).rows[0].name;
    expect(await nameOf(unnamed)).toBe("api.acme.dev");
    // A name the seller chose is kept.
    const named = await seedApi(db.pool, { openapiUrl: link, name: "Acme prices" });
    await parseStep({ pool: db.pool, fetchSpec }, named);
    expect(await nameOf(named)).toBe("Acme prices");
  });
  it("accepts an API on another host than its OpenAPI file", async () => {
    const apiId = await seedApi(db.pool, {});
    await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url: "https://other-host.example/v1" }])) }, apiId);
    expect(await baseOf(apiId)).toEqual({ origin: "https://other-host.example", path_prefix: "/v1", state: "parsed" });
  });
  it("refuses a relative or missing servers URL for a file on GitHub, with a clear message", async () => {
    for (const spec of [withServers([{ url: "/v1" }]), PRICE_SPEC]) {
      const apiId = await seedApi(db.pool, { openapiUrl: "https://raw.githubusercontent.com/acme/price/main/openapi.json" });
      expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(spec) }, apiId)).toBe("failed");
      expect(await errorOf(apiId)).toMatch(/on raw\.githubusercontent\.com, which can't be where your API runs\. Set the first servers URL in the file to your API's full base URL/);
      expect(await baseOf(apiId)).toEqual({ origin: "https://price.example.dev", path_prefix: "/", state: "intake" });
    }
  });
  it.each([
    ["http://api.acme.dev/v1", /must start with https/],
    ["https://user:pw@api.acme.dev/v1", /username or password/],
    ["https://api.acme.dev./v1", /dot at the end of its host name/],
    ["https://api.acme.dev/v1?x=1", /\?query or #fragment/],
    ["https://api.acme.dev/v1%2Fadmin", /encoded slash, dot or a ';'/],
    ["https://api.acme.dev/v1;x", /encoded slash, dot or a ';'/],
    ["https://api.acme.dev//v1", /two slashes in a row/],
    ["https://api.acme.dev/{version}", /\{variable\} with no default/],
  ])("refuses the base %s", async (url, why) => {
    const apiId = await seedApi(db.pool, {});
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(withServers([{ url }])) }, apiId)).toBe("failed");
    expect(await errorOf(apiId)).toMatch(why);
    expect((await baseOf(apiId)).state).toBe("intake");
  });
  it("accepts http on localhost only when insecure upstreams are allowed", async () => {
    const spec = withServers([{ url: "http://localhost:4010/v1" }]);
    const refused = await seedApi(db.pool, {});
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(spec) }, refused)).toBe("failed");
    const allowed = await seedApi(db.pool, {});
    expect(await parseStep({ pool: db.pool, fetchSpec: vi.fn().mockResolvedValue(spec), allowInsecure: true }, allowed)).toBe("ran");
    expect(await baseOf(allowed)).toEqual({ origin: "http://localhost:4010", path_prefix: "/v1", state: "parsed" });
  });
});
