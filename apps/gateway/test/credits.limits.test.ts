import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  generateUpstreamAuthKeys, KEY_FORBIDDEN_TEXT, KEY_REFUSED_TEXT, sealUpstreamBag, sealUpstreamSecret, type StoredUpstreamAuth,
} from "@hirakumi/core";
import { FAILED_CALLS_LIMIT } from "../src/credits";
import { anotherBase, insertActiveToken, makeHarness, seedLiveApi, type Harness, type Seeded } from "./helpers";

const keys = generateUpstreamAuthKeys();
const KEY = "sk_test/0123456789+abcdef";

let h: Harness;
beforeEach(async () => { h = await makeHarness({ config: { upstreamAuthPrivateKey: keys.privateKey } }); });
afterEach(async () => { await h.close(); });

const call = (apiId: string, token: string) =>
  request(h.app).get(`/a/${apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
const remaining = async (id: string) =>
  (await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${id}`)[0]!.remaining;
const callRows = async (id: string) =>
  (await h.sql<{ n: number }[]>`select count(*)::int as n from calls where credit_token_id = ${id}`)[0]!.n;
const setAuth = async (apiId: string, stored: StoredUpstreamAuth) => {
  await h.sql`update apis set upstream_auth = ${h.sql.json(stored)} where id = ${apiId}`;
  h.registry.invalidate(apiId);
};

/** A second API under its own path prefix, whose /price answer is `status` with `headers`. */
async function apiAnswering(status: number, headers: Record<string, string> = {}): Promise<{ s: Seeded; prefix: string }> {
  const prefix = anotherBase();
  const s = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: prefix });
  h.stub.setFile(`${prefix}/price`, '{"error":"no"}', { status, headers });
  return { s, prefix };
}

describe("upstream 429", () => {
  it("is a 503 upstream_rate_limited with the seller's Retry-After; the credit is released", async () => {
    const { s } = await apiAnswering(429, { "retry-after": "30" });
    const t = await insertActiveToken(h.sql, s, 5);
    const r = await call(s.apiId, t.token);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "upstream_rate_limited", reasons: expect.any(Array) });
    expect(r.headers["retry-after"]).toBe("30");
    expect(r.headers["x-credits-remaining"]).toBe("5");
    expect(await remaining(t.id)).toBe(5);
  });

  it("has no Retry-After when the seller's doesn't parse", async () => {
    const { s } = await apiAnswering(429, { "retry-after": "soon" });
    const t = await insertActiveToken(h.sql, s, 5);
    const r = await call(s.apiId, t.token);
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(r.headers["x-credits-remaining"]).toBe("5");
  });
});

describe("a keyed API's refusal", () => {
  it.each([
    [401, "refused", KEY_REFUSED_TEXT],
    [403, "forbidden", KEY_FORBIDDEN_TEXT],
  ] as const)("%i is a 422 with auth '%s' and the key reason first; the credit is released", async (status, auth, reason) => {
    const { s, prefix } = await apiAnswering(status);
    const where = { in: "header" as const, name: "X-API-Key" };
    await setAuth(s.apiId, {
      ...where, hint: "cdef",
      sealed: sealUpstreamSecret(keys.publicKey, { apiId: s.apiId, ...where, origin: h.stub.origin, pathPrefix: prefix }, KEY),
    });
    const t = await insertActiveToken(h.sql, s, 5);
    const r = await call(s.apiId, t.token);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "promise_not_met", auth });
    expect(r.body.reasons[0]).toBe(reason);
    expect(r.headers["x-credits-remaining"]).toBe("5");
    expect(await remaining(t.id)).toBe(5);
  });

  it("a keyless 401 has no auth field", async () => {
    const { s } = await apiAnswering(401);
    const t = await insertActiveToken(h.sql, s, 5);
    const r = await call(s.apiId, t.token);
    expect(r.status).toBe(422);
    expect(r.body).not.toHaveProperty("auth");
  });
});

describe("an hks3 bag", () => {
  it("an answer that echoes a part is a 502 and the credit is released", async () => {
    const parts = [{ in: "header" as const, name: "X-API-Key" }, { in: "header" as const, name: "X-Client" }];
    const sealed = sealUpstreamBag(keys.publicKey, { apiId: h.seeded.apiId, parts, origin: h.stub.origin, pathPrefix: "/" },
      { values: [KEY, "client-public"], fixed: [1], leak: [] });
    await setAuth(h.seeded.apiId, { v: 3, parts: parts.map((p) => ({ ...p, hint: "" })), sealed });
    h.stub.setMode("echo");
    const t = await insertActiveToken(h.sql, h.seeded, 5);
    const r = await call(h.seeded.apiId, t.token);
    expect(h.stub.lastHeaders()?.["x-api-key"]).toBe(KEY);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("upstream_error");
    expect(r.text).not.toContain(KEY);
    expect(r.headers["x-credits-remaining"]).toBe("5");
    expect(await remaining(t.id)).toBe(5);
  });
});

describe("free failed calls per token", () => {
  it(`the ${FAILED_CALLS_LIMIT.max + 1}st failure in a minute is a 429 with no upstream call and nothing reserved; another token is unaffected`, async () => {
    h.stub.setMode("empty");
    const t = await insertActiveToken(h.sql, h.seeded, 5);
    for (let i = 0; i < FAILED_CALLS_LIMIT.max; i++) expect((await call(h.seeded.apiId, t.token)).status).toBe(422);
    const hits = h.stub.hits();
    const r = await call(h.seeded.apiId, t.token);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("too_many_failed_calls");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(r.headers["x-credits-remaining"]).toBeUndefined();
    expect(h.stub.hits()).toBe(hits);
    expect(await callRows(t.id)).toBe(FAILED_CALLS_LIMIT.max);
    expect(await remaining(t.id)).toBe(5);

    const other = await insertActiveToken(h.sql, h.seeded, 5);
    expect((await call(h.seeded.apiId, other.token)).status).toBe(422);
    // A blocked token stays blocked even when the upstream recovers, until the window moves on.
    h.stub.setMode("ok");
    expect((await call(h.seeded.apiId, t.token)).status).toBe(429);
    expect((await call(h.seeded.apiId, other.token)).status).toBe(200);
  });

  it(`calls running at once count too: of ${FAILED_CALLS_LIMIT.max * 2} started together, at most ${FAILED_CALLS_LIMIT.max} reach the upstream`, async () => {
    h.stub.setMode("slow"); // answers after the upstream timeout, so every call is still running when the next starts
    const n = FAILED_CALLS_LIMIT.max * 2;
    const t = await insertActiveToken(h.sql, h.seeded, n);
    const hits = h.stub.hits();
    const rs = await Promise.all(Array.from({ length: n }, () => call(h.seeded.apiId, t.token)));
    expect(h.stub.hits() - hits).toBeLessThanOrEqual(FAILED_CALLS_LIMIT.max);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(n - FAILED_CALLS_LIMIT.max);
    expect(await remaining(t.id)).toBe(n);
  });

  it(`a busy token whose calls pass is never refused: ${FAILED_CALLS_LIMIT.max * 2} at once all answer 200`, async () => {
    const n = FAILED_CALLS_LIMIT.max * 2;
    const t = await insertActiveToken(h.sql, h.seeded, n);
    const rs = await Promise.all(Array.from({ length: n }, () => call(h.seeded.apiId, t.token)));
    expect(rs.map((r) => r.status)).toEqual(Array(n).fill(200));
    expect(await remaining(t.id)).toBe(0);
  });

  it("a burst with a token this API doesn't know is all 401s, never 429s", async () => {
    const other = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    const t = await insertActiveToken(h.sql, h.seeded, 5);
    const rs = await Promise.all(Array.from({ length: FAILED_CALLS_LIMIT.max * 2 }, () => call(other.apiId, t.token)));
    expect(rs.every((r) => r.status === 401)).toBe(true);
    expect(await remaining(t.id)).toBe(5);
  });

  it("passing calls never count", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, FAILED_CALLS_LIMIT.max + 5);
    for (let i = 0; i < FAILED_CALLS_LIMIT.max + 2; i++) expect((await call(h.seeded.apiId, t.token)).status).toBe(200);
    h.stub.setMode("empty");
    expect((await call(h.seeded.apiId, t.token)).status).toBe(422);
  });

  it("upstream 429s count as failures", async () => {
    const { s } = await apiAnswering(429);
    const t = await insertActiveToken(h.sql, s, 5);
    for (let i = 0; i < FAILED_CALLS_LIMIT.max; i++) expect((await call(s.apiId, t.token)).status).toBe(503);
    expect((await call(s.apiId, t.token)).status).toBe(429);
  });
});
