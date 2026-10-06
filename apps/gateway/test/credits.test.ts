import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { inputHash } from "@hirakumi/core";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const path = () => `/a/${h.seeded.apiId}/x/getPrice`;
const remaining = async (id: string) =>
  (await h.sql<{ remaining: number; status: string }[]>`select remaining, status from credit_tokens where id = ${id}`)[0];
const goDown = () => {
  h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
  h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
};

describe("routing and input", () => {
  it("404 for an unknown API or operation", async () => {
    expect((await request(h.app).get("/a/api_nope/x/getPrice?symbol=ADA")).status).toBe(404);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/nope?symbol=ADA`)).status).toBe(404);
  });
  it("400 for bad input, before anything else", async () => {
    const r = await request(h.app).get(`${path()}?x=1`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "invalid_input" });
    expect(r.body.reasons).toContain("/symbol is missing");
    expect(h.stub.hits()).toBe(0);
  });
});

describe("no token", () => {
  it("402 with pack offers, rule hash and rule URL", async () => {
    const r = await request(h.app).get(`${path()}?symbol=ADA`);
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      error: "credits_required",
      packs: [{ packId: h.seeded.packId, calls: 100, price: "2000000", asset: USDM_PREPROD_ASSET,
                buyUrl: `https://gw.test/a/${h.seeded.apiId}/packs/${h.seeded.packId}` }],
      ruleHash: h.seeded.ruleHash,
      ruleUrl: `https://gw.test/r/${h.seeded.ruleHash}`,
    });
    expect(h.stub.hits()).toBe(0);
  });
  it("503 before 402 when the API is Down (no payment asked)", async () => {
    goDown();
    const r = await request(h.app).get(`${path()}?symbol=ADA`);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "api_down", estimated_downtime_seconds: 20 });
  });
});

describe("with a token", () => {
  it("200, one credit used, evidence logged keyed by token id", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-credits-remaining"]).toBe("99");
    expect(r.body.symbol).toBe("ADA");
    expect(await remaining(t.id)).toEqual({ remaining: 99, status: "active" });
    const [call] = await h.sql<{ kind: string; verdict: string; execution: string; input_hash: string; output_hash: string }[]>`
      select kind, verdict, execution, input_hash, output_hash from calls where credit_token_id = ${t.id}`;
    expect(call).toMatchObject({ kind: "credit", verdict: "pass", execution: "upstream_ok", input_hash: inputHash(t.id, { symbol: "ADA" }) });
    expect(call.output_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    ["empty", 422, "promise_not_met"],
    ["stale", 422, "promise_not_met"],
    ["html", 422, "promise_not_met"],
    ["error500", 502, "upstream_error"],
    ["slow", 504, "upstream_timeout"],
  ] as const)("%s → %i and the credit balance is unchanged", async (mode, status, error) => {
    const t = await insertActiveToken(h.sql, h.seeded);
    h.stub.setMode(mode);
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(error);
    expect(r.headers["x-credits-remaining"]).toBe("100");
    expect(await remaining(t.id)).toEqual({ remaining: 100, status: "active" });
  });
  it("422 names the failing fields", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    h.stub.setMode("empty");
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["/price is missing", "/symbol is missing", "/updatedAt is missing"]));
  });
  it("401 invalid_token for an unknown token, 401 token_pending for an unsettled one (contract v1.1 G4)", async () => {
    const unknown = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer hk_${"A".repeat(43)}`);
    expect(unknown.status).toBe(401);
    const p = await insertActiveToken(h.sql, h.seeded, 100, "pending");
    const pending = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${p.token}`);
    expect(pending.status).toBe(401);
    expect(pending.body.error).toBe("token_pending");
    expect(h.stub.hits()).toBe(0);
  });
  it("last credit race over HTTP: exactly one 200, the rest 402, token exhausted", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    const rs = await Promise.all(Array.from({ length: 6 }, () =>
      request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 402 && r.body.error === "credits_required")).toHaveLength(5);
    expect(await remaining(t.id)).toEqual({ remaining: 0, status: "exhausted" });
  });
  it("503 while Down even with credits; no credit used", async () => {
    const t = await insertActiveToken(h.sql, h.seeded);
    goDown();
    const r = await request(h.app).get(`${path()}?symbol=ADA`).set("authorization", `Bearer ${t.token}`);
    expect(r.status).toBe(503);
    expect(await remaining(t.id)).toEqual({ remaining: 100, status: "active" });
  });
});

describe("/r/:ruleHash", () => {
  it("returns the rule JSON and plain English", async () => {
    const r = await request(h.app).get(`/r/${h.seeded.ruleHash}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ruleHash: h.seeded.ruleHash, version: 1, plain_english: expect.stringContaining("symbol") });
    expect(r.body.definition.schema.required).toEqual(["price", "symbol", "updatedAt"]);
    expect((await request(h.app).get("/r/sha256:nope")).status).toBe(404);
  });
});
