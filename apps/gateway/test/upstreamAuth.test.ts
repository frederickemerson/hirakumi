import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { generateUpstreamAuthKeys, sealUpstreamSecret, type StoredUpstreamAuth } from "@hirakumi/core";
import { JobRunner } from "../src/jobs";
import { Monitor } from "../src/monitor";
import { openCredential } from "../src/registry";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

const keys = generateUpstreamAuthKeys();
const KEY = "sk_test/0123456789+abcdef";
const stored = (apiId: string, o: Partial<StoredUpstreamAuth> = {}, publicKey = keys.publicKey): StoredUpstreamAuth =>
  ({ in: "header", name: "X-API-Key", sealed: sealUpstreamSecret(publicKey, apiId, KEY), hint: "cdef", ...o });

describe("openCredential", () => {
  it("an API without a stored key needs none", () => {
    expect(openCredential({ id: "api_a", upstream_auth: null }, keys.privateKey)).toEqual({ credential: null, credentialError: null });
    expect(openCredential({ id: "api_a", upstream_auth: null }, null)).toEqual({ credential: null, credentialError: null });
  });
  it("opens a key sealed for this API", () => {
    expect(openCredential({ id: "api_a", upstream_auth: stored("api_a") }, keys.privateKey))
      .toEqual({ credential: { in: "header", name: "X-API-Key", value: KEY }, credentialError: null });
    expect(openCredential({ id: "api_a", upstream_auth: stored("api_a", { in: "query", name: "api_key" }) }, keys.privateKey).credential)
      .toEqual({ in: "query", name: "api_key", value: KEY });
  });
  it("without the gateway's private key the API is blocked, and the reason names no setting", () => {
    const r = openCredential({ id: "api_a", upstream_auth: stored("api_a") }, null);
    expect(r.credential).toBeNull();
    expect(r.credentialError).toMatch(/needs a key/);
    expect(r.credentialError).not.toMatch(/UPSTREAM_AUTH/);
  });
  it("refuses a key sealed for another API, a tampered one, another gateway's, or a stored name it would not accept", () => {
    const refused = (o: Parameters<typeof openCredential>[0], pk = keys.privateKey) => {
      const r = openCredential(o, pk);
      expect(r.credential).toBeNull();
      expect(r.credentialError).toMatch(/could not be read/);
    };
    refused({ id: "api_b", upstream_auth: stored("api_a") });
    const s = stored("api_a");
    const parts = s.sealed.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    refused({ id: "api_a", upstream_auth: { ...s, sealed: parts.join(".") } });
    refused({ id: "api_a", upstream_auth: { ...s, sealed: "garbage" } });
    refused({ id: "api_a", upstream_auth: s }, generateUpstreamAuthKeys().privateKey);
    // The name and placement are stored in the clear, so a reserved header or a bad name is refused here too.
    refused({ id: "api_a", upstream_auth: { ...s, name: "Host" } });
    refused({ id: "api_a", upstream_auth: { ...s, name: "X-Key\r\nX-Evil" } });
    refused({ id: "api_a", upstream_auth: { ...s, in: "cookie" as never } });
  });
});

describe("an API that needs a key, through the gateway", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });
  const internal = { authorization: "Bearer internal-test-token-0123456789" };
  const preview = () => request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(internal).send({ input: { symbol: "ADA" } });
  const setAuth = async (v: StoredUpstreamAuth | null) => {
    await h.sql`update apis set upstream_auth = ${v ? h.sql.json(v) : null} where id = ${h.seeded.apiId}`;
    await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set(internal).expect(200);
  };

  it("preview and paid calls send the key; the answer and receipts never show it", async () => {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    await setAuth(stored(h.seeded.apiId));
    const p = await preview();
    expect(p.status).toBe(200);
    expect(p.body.verdict).toEqual({ pass: true, reasons: [] });
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe(KEY);

    const { token } = await insertActiveToken(h.sql, h.seeded, 5);
    const paid = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    expect(paid.status).toBe(200);
    expect(paid.headers["x-credits-remaining"]).toBe("4");
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe(KEY);
    // A buyer can't send their own header in its place: only the query and body are passed on.
    await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`).set("x-api-key", "buyer");
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe(KEY);
  });

  it("a query key: an answer that repeats it is withheld, no credit is used, and nothing stored or logged quotes it", async () => {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    await setAuth(stored(h.seeded.apiId, { in: "query", name: "api_key" }));
    h.stub.setMode("echo");
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 5);
    const paid = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA&api_key=x`).set("authorization", `Bearer ${token}`);
    // additionalProperties: false in the input schema refuses api_key from a buyer before anything is sent.
    expect(paid.status).toBe(400);
    const ok = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    expect(ok.status).toBe(502);
    expect(ok.body).toEqual({ error: "upstream_error", reasons: ["the answer contained the API's key, so it was withheld"] });
    expect(ok.headers["x-credits-remaining"]).toBe("5");
    expect(new URL(h.stub.lastUrl()!, "http://x").searchParams.get("api_key")).toBe(KEY);
    const [t] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`;
    expect(t.remaining).toBe(5);
    const receipts = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${token}`);
    expect(receipts.body.calls).toMatchObject([
      { verdict: "fail", charged: false, reasons: ["the answer contained the API's key, so it was withheld"], outputHash: null },
    ]);

    const p = await preview();
    expect(p.status).toBe(502);
    // The monitor marks it failing with the same plain reason.
    const m = new Monitor({ sql: h.sql, registry: h.registry, health: h.health, config: h.config });
    await m.probeApi(h.seeded.apiId);
    await m.probeApi(h.seeded.apiId);
    const health = await request(h.app).get(`/internal/apis/${h.seeded.apiId}/health`).set(internal);
    expect(health.body.health).toBe("down");
    expect(health.body.lastReasons).toEqual(["getPrice: the answer contained the API's key, so it was withheld"]);

    // Escrow job: no result is stored or submitted, and the failure reasons don't quote it.
    const runner = new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });
    await h.sql`update apis set health = 'healthy' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    const started = await request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send({ input_data: { symbol: "ADA" }, identifier_from_purchaser: "aabbccddeeff00112233" });
    expect(started.status).toBe(200);
    h.masumi.state = "FundsLocked";
    await runner.tick();
    const status = await request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: started.body.job_id });
    expect(status.body).toMatchObject({ status: "failed", reasons: ["the answer contained the API's key, so it was withheld"] });
    expect(h.masumi.submitted).toHaveLength(0);

    const dump = JSON.stringify([
      receipts.body, p.body, health.body, status.body,
      await h.sql`select verdict_reasons, output_hash from calls`, await h.sql`select output, failure_reasons from jobs`,
      await h.sql`select * from health_events`,
    ]);
    for (const f of [KEY, encodeURIComponent(KEY)]) expect(dump).not.toContain(f);
    expect(dump).not.toContain("sk_test");
  });

  it("without the private key, or after the key stops opening, every call is blocked and never reaches the API", async () => {
    h = await makeHarness();
    await setAuth(stored(h.seeded.apiId));
    const p = await preview();
    expect(p.status).toBe(400);
    expect(p.body).toEqual({ error: "blocked", detail: "blocked: this API needs a key, and the gateway can't read keys right now" });
    const { token } = await insertActiveToken(h.sql, h.seeded, 5);
    const paid = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
    expect(paid.status).toBe(502);
    expect(paid.headers["x-credits-remaining"]).toBe("5");
    expect(h.stub.hits()).toBe(0);
  });

  it("a key sealed for another API is blocked; removing it sends calls without a key again", async () => {
    h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } });
    await setAuth(stored("api_someone_else"));
    expect((await preview()).body.detail).toMatch(/could not be read/);
    expect(h.stub.hits()).toBe(0);
    await setAuth(null);
    expect((await preview()).status).toBe(200);
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBeUndefined();
  });
});
