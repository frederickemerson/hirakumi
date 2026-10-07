import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  generateUpstreamAuthKeys, KEY_REFUSED_TEXT, newId, OPERATOR_KEYS_UNAVAILABLE, sealUpstreamSecret, type StoredUpstreamSecret,
} from "@hirakumi/core";
import { Monitor } from "../src/monitor";
import { makeHarness, PRICE_INPUT_SCHEMA, PRICE_RULE, type Harness } from "./helpers";

let h: Harness; let m: Monitor;
beforeEach(async () => {
  h = await makeHarness();
  m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
});
afterEach(async () => { m.stop(); await h.close(); });

const events = () => h.sql<{ from_health: string; to_health: string; reasons: Array<{ op: string; reason: string; since: string | null }> }[]>`
  select from_health, to_health, reasons from health_events order by id`;

describe("Monitor (demo thresholds: 2 fails → Down, 2 passes → Live)", () => {
  it("an API with nothing it can check is not reported Live (audit I4)", async () => {
    await h.sql`delete from test_inputs`;
    await m.probeApi(h.seeded.apiId);
    const t = await m.probeApi(h.seeded.apiId);
    expect(t?.to).toBe("down");
    expect(t?.reasons[0].reason).toMatch(/no saved test input/);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(503);
  });

  it("stays Live while probes pass and logs probe calls with the probe header", async () => {
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(h.health.get(h.seeded.apiId)?.health).toBe("healthy");
    expect(h.stub.lastHeaders()?.["x-hirakumi-probe"]).toBe("1");
    const [c] = await h.sql<{ kind: string; verdict: string }[]>`select kind, verdict from calls`;
    expect(c).toEqual({ kind: "probe", verdict: "pass" });
    const [api] = await h.sql<{ health_checked_at: Date | null }[]>`select health_checked_at from apis`;
    expect(api.health_checked_at).not.toBeNull();
  });

  it("flips to Down on the 2nd failure: DB, health_events, /availability 503, proxy 503, pack 503", async () => {
    h.stub.setMode("empty");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ from: "healthy", to: "down" });
    const [api] = await h.sql<{ health: string }[]>`select health from apis`;
    expect(api.health).toBe("down");
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_health: "healthy", to_health: "down" });
    expect(ev[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ op: "getPrice", reason: "/price is missing" })]));
    expect(ev[0].reasons[0].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(503);
    expect(av.body).toMatchObject({ status: "unavailable", estimated_downtime_seconds: 20 });
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`)).status).toBe(503);
    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/${h.seeded.packId}`)).status).toBe(503);
  });

  it("comes back Live after 2 passes and writes a second event", async () => {
    h.stub.setMode("empty");
    await m.probeApi(h.seeded.apiId);
    await m.probeApi(h.seeded.apiId);
    h.stub.setMode("ok");
    expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(await m.probeApi(h.seeded.apiId)).toMatchObject({ from: "down", to: "healthy" });
    expect((await events()).map((e) => e.to_health)).toEqual(["down", "healthy"]);
    const av = await request(h.app).get(`/a/${h.seeded.apiId}/availability`);
    expect(av.status).toBe(200);
    expect(av.body).toMatchObject({ status: "available", type: "masumi-agent" });
  });

  it("tick() probes every live/registering API and skips others", async () => {
    await h.sql`update apis set state = 'priced'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(0);
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    await m.tick();
    expect(h.stub.hits()).toBe(1);
  });

  it("/availability answers 200 during registration (the registry checks it then) and 404 for unknown", async () => {
    await h.sql`update apis set state = 'registering'`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(200);
    expect((await request(h.app).get(`/a/api_nope/availability`)).status).toBe(404);
  });
});

const keys = generateUpstreamAuthKeys();
const KEY = "sk_test/0123456789+abcdef";

describe("Monitor and the API's key (3 fails → Down)", () => {
  const internal = { authorization: "Bearer internal-test-token-0123456789" };
  /** A fresh harness at production thresholds, with or without the gateway's private key, and a key stored on the API. */
  const keyed = async (privateKey: string | null) => {
    m.stop(); await h.close();
    h = await makeHarness({ config: { upstreamAuthPrivateKey: privateKey, thresholds: { failsToDown: 3, passesToHeal: 2 } } });
    m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
    const where = { in: "header" as const, name: "X-API-Key" };
    const stored: StoredUpstreamSecret = {
      ...where, hint: "cdef",
      sealed: sealUpstreamSecret(keys.publicKey, { apiId: h.seeded.apiId, ...where, origin: h.stub.origin, pathPrefix: "/" }, KEY),
    };
    await h.sql`update apis set upstream_auth = ${h.sql.json(stored)} where id = ${h.seeded.apiId}`;
    await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set(internal).expect(200);
  };
  const rateLimited = (path = "/price") => h.stub.setFile(path, '{"error":"slow down"}', { status: 429, headers: { "retry-after": "30" } });

  it("three 401 ticks turn the API Down with the key reason", async () => {
    await keyed(keys.privateKey);
    h.stub.setFile("/price", '{"error":"unauthorized"}', { status: 401 });
    for (let i = 0; i < 2; i++) expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(await m.probeApi(h.seeded.apiId)).toMatchObject({ from: "healthy", to: "down" });
    const [ev] = await events();
    expect(ev.reasons[0]).toMatchObject({ op: "getPrice", reason: KEY_REFUSED_TEXT });
  });

  it("one 401 tick then a pass stays healthy", async () => {
    await keyed(keys.privateKey);
    h.stub.setFile("/price", '{"error":"unauthorized"}', { status: 401 });
    await m.probeApi(h.seeded.apiId);
    h.stub.setFile("/price", JSON.stringify({ symbol: "ADA", price: 0.42, updatedAt: new Date().toISOString() }));
    await m.probeApi(h.seeded.apiId);
    expect(h.health.get(h.seeded.apiId)?.health).toBe("healthy");
    expect(await events()).toEqual([]);
  });

  it("every op answering 429 for 5 ticks records nothing: the API stays healthy", async () => {
    rateLimited();
    for (let i = 0; i < 5; i++) expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    expect(h.stub.fileHits("/price")).toBe(5);
    expect(h.health.get(h.seeded.apiId)?.health ?? "healthy").toBe("healthy");
    expect(h.health.get(h.seeded.apiId)?.lastReasons ?? []).toEqual([]);
    expect(await events()).toEqual([]);
    const [api] = await h.sql<{ health: string; health_checked_at: Date | null }[]>`select health, health_checked_at from apis`;
    expect(api).toMatchObject({ health: "healthy" });
    expect(api.health_checked_at).not.toBeNull();
  });

  it("one op answering 429 and another failing: only the failing op's reason counts", async () => {
    const opRow = newId("op");
    await h.sql`
      insert into operations (id, api_id, op_id, method, path, input_schema, enabled, side_effects_confirmed_none)
      values (${opRow}, ${h.seeded.apiId}, 'getQuote', 'GET', '/quote', ${h.sql.json(PRICE_INPUT_SCHEMA)}, true, true)`;
    await h.sql`
      insert into rules (id, operation_id, version, definition, hash, plain_english)
      values (${newId("rule")}, ${opRow}, 1, ${h.sql.json(PRICE_RULE as never)}, ${h.seeded.ruleHash}, 'A price.')`;
    await h.sql`insert into test_inputs (id, operation_id, input) values (${newId("ti")}, ${opRow}, ${h.sql.json({ symbol: "ADA" })})`;
    h.registry.invalidate(h.seeded.apiId);
    rateLimited();
    h.stub.setFile("/quote", "{}");
    await m.probeApi(h.seeded.apiId);
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ to: "down" });
    expect(t!.reasons.length).toBeGreaterThan(0);
    expect(t!.reasons.every((r) => r.op === "getQuote")).toBe(true);
  });

  it("without the gateway's private key: Down after 3 ticks with only the operator reason, no upstream call, every sale refused", async () => {
    await keyed(null);
    const calls = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from calls where kind = 'probe'`)[0].n;
    for (let i = 0; i < 2; i++) expect(await m.probeApi(h.seeded.apiId)).toBeNull();
    const t = await m.probeApi(h.seeded.apiId);
    expect(t).toMatchObject({ from: "healthy", to: "down" });
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0].reasons).toEqual([expect.objectContaining({ op: "*", reason: OPERATOR_KEYS_UNAVAILABLE })]);
    expect(await calls()).toBe(0);
    expect(h.stub.hits()).toBe(0);

    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/${h.seeded.packId}`)).status).toBe(503);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`)).status).toBe(503);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/availability`)).status).toBe(503);
    const job = await request(h.app).post(`/a/${h.seeded.apiId}/start_job`)
      .send({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "aabbccddeeff00112233" });
    expect(job.status).toBe(503);
    h.config.tryLiveApis = [h.seeded.apiId];
    const demo = await request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set(internal);
    expect(demo.status).toBe(503);
    expect(demo.body.error).toBe("api_down");
    expect(h.stub.hits()).toBe(0);
  });
});
