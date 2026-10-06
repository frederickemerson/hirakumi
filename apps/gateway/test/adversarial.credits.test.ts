// Adversarial review: credit calls (reserve → upstream → rule → commit/release), health gating, MIP-003 jobs.
// Every test asserts the SAFE behaviour, so a failing test is a demonstrated vulnerability.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { releaseCredit, markExhaustedIfEmpty, reserveCredit } from "@hirakumi/db";
import { sha256Hex } from "@hirakumi/core";
import { JobRunner } from "../src/jobs";
import { anotherBase, insertActiveToken, makeHarness, seedLiveApi, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const path = (apiId = h.seeded.apiId) => `/a/${apiId}/x/getPrice?symbol=ADA`;
const call = (token: string, apiId?: string) => request(h.app).get(path(apiId)).set("authorization", `Bearer ${token}`);
const tokenRow = async (id: string) =>
  (await h.sql<{ status: string; remaining: number }[]>`select status, remaining from credit_tokens where id = ${id}`)[0]!;

describe("adversarial: credit races", () => {
  it("12 concurrent calls racing for the last credit: exactly one is served and charged", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    const rs = await Promise.all(Array.from({ length: 12 }, () => call(t.token)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 402)).toHaveLength(11);
    expect(h.stub.hits()).toBe(1);
    expect(await tokenRow(t.id)).toEqual({ status: "exhausted", remaining: 0 });
  });

  it("a release racing an exhaust revives the token with the right count", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 2);
    const a = await reserveCredit(h.sql, h.seeded.apiId, sha256Hex(t.token));
    const b = await reserveCredit(h.sql, h.seeded.apiId, sha256Hex(t.token));
    expect(a.ok && b.ok).toBe(true);
    await markExhaustedIfEmpty(h.sql, t.id); // b passed with remainingAfter 0
    await releaseCredit(h.sql, t.id); // a failed
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 1 });
    expect((await call(t.token)).status).toBe(200);
    expect(await tokenRow(t.id)).toEqual({ status: "exhausted", remaining: 0 });
  });

  it("many concurrent mixed pass/fail calls never lose or mint credits", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 10);
    h.stub.setMode("empty");
    const fails = await Promise.all(Array.from({ length: 10 }, () => call(t.token)));
    expect(fails.every((r) => r.status === 422)).toBe(true);
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 10 });
  });
});

describe("adversarial: failed responses never use a credit", () => {
  for (const mode of ["error500", "empty", "stale", "html", "slow"] as const) {
    it(`upstream ${mode}`, async () => {
      const t = await insertActiveToken(h.sql, h.seeded, 1);
      h.stub.setMode(mode);
      const r = await call(t.token);
      expect(r.status).not.toBe(200);
      expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 1 });
    });
  }

  it("upstream unreachable (connection refused) → 502, credit kept", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    await h.sql`update apis set origin = 'http://127.0.0.1:1' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await call(t.token)).status).toBe(502);
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 1 });
  });

  it("an internal error while recording the call (thrown after reserve) gives the credit back", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    await h.sql`alter table calls add constraint adversarial_no_calls check (false) not valid`;
    expect((await call(t.token)).status).toBe(500);
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 1 });
  });

  it("a DB error after a passing upstream (before the body is sent) must not use the credit", async () => {
    // Any transient failure in markExhaustedIfEmpty / finishChannelCall: the buyer gets a 500 and no body.
    const t = await insertActiveToken(h.sql, h.seeded, 1);
    await h.sql`create function adversarial_boom() returns trigger language plpgsql as $$ begin raise exception 'db hiccup'; end $$`;
    await h.sql`create trigger adversarial_boom before update on credit_tokens for each row when (new.status = 'exhausted') execute function adversarial_boom()`;
    const r = await call(t.token);
    expect(r.status).toBe(500);
    expect(await tokenRow(t.id), "the buyer received a 500 and no answer, but the credit is gone").toEqual({ status: "active", remaining: 1 });
  });
});

describe("adversarial: tokens that must never buy a call", () => {
  it("pending, revoked, exhausted, other-API, malformed, query-string and lowercase-scheme tokens", async () => {
    const pending = await insertActiveToken(h.sql, h.seeded, 5, "pending");
    const revoked = await insertActiveToken(h.sql, h.seeded, 5, "revoked");
    const exhausted = await insertActiveToken(h.sql, h.seeded, 0, "exhausted");
    const other = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    const foreign = await insertActiveToken(h.sql, other, 5);
    expect((await call(pending.token)).body.error).toBe("token_pending");
    expect((await call(revoked.token)).status).toBe(401);
    expect((await call(exhausted.token)).status).toBe(402);
    expect((await call(foreign.token)).status).toBe(401);
    expect((await call("hk_" + "A".repeat(43))).status).toBe(401);
    expect((await call(foreign.token.slice(0, -1))).status).toBe(401);
    const good = await insertActiveToken(h.sql, h.seeded, 5);
    expect((await request(h.app).get(`${path()}&access_token=${good.token}`)).status).not.toBe(200);
    expect((await request(h.app).get(path()).set("authorization", `bearer ${good.token}`)).status).toBe(401);
    expect((await request(h.app).get(path()).set("authorization", `Bearer ${good.token}, Bearer ${good.token}`)).status).toBe(401);
    expect(h.stub.hits()).toBe(0);
    expect(await tokenRow(good.id)).toEqual({ status: "active", remaining: 5 });
    expect(await tokenRow(foreign.id)).toEqual({ status: "active", remaining: 5 });
  });

  it("a 300 KB body is refused before any credit is touched", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 5);
    const r = await request(h.app).get(path()).set("authorization", `Bearer ${t.token}`).set("content-type", "application/json").send(JSON.stringify({ x: "a".repeat(300_000) }));
    expect(r.status).toBe(413);
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 5 });
  });

  it("wrong method / unknown op / invalid input never touch a credit", async () => {
    const t = await insertActiveToken(h.sql, h.seeded, 5);
    expect((await request(h.app).post(path()).set("authorization", `Bearer ${t.token}`)).status).toBe(405);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/nope`).set("authorization", `Bearer ${t.token}`)).status).toBe(404);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=A`).set("authorization", `Bearer ${t.token}`)).status).toBe(400);
    expect(await tokenRow(t.id)).toEqual({ status: "active", remaining: 5 });
  });
});

describe("adversarial: health", () => {
  it("a Down API (from the DB at boot, or by probes) takes no credit and never calls upstream", async () => {
    const down = await seedLiveApi(h.sql, h.stub.origin, { health: "down", pathPrefix: anotherBase() });
    const t1 = await insertActiveToken(h.sql, down, 5);
    expect((await call(t1.token, down.apiId)).status).toBe(503);
    const t2 = await insertActiveToken(h.sql, h.seeded, 5);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    expect((await call(t2.token)).status).toBe(503);
    expect(h.stub.hits()).toBe(0);
    expect(await tokenRow(t1.id)).toMatchObject({ remaining: 5 });
    expect(await tokenRow(t2.id)).toMatchObject({ remaining: 5 });
  });

  it("probe / preview / reload endpoints need the internal token", async () => {
    for (const [m, p] of [["post", `/internal/preview/${h.seeded.apiId}/getPrice`], ["post", `/internal/apis/${h.seeded.apiId}/reload`], ["get", `/internal/apis/${h.seeded.apiId}/health`]] as const) {
      expect((await request(h.app)[m](p).set("authorization", "Bearer wrong")).status).toBe(401);
    }
    expect(h.stub.hits()).toBe(0);
  });
});

describe("adversarial: MIP-003 escrow jobs", () => {
  const PID = "aabbccddeeff00112233";
  const start = () => request(h.app).post(`/a/${h.seeded.apiId}/start_job`).send({ input_data: { symbol: "ADA" }, identifier_from_purchaser: PID });
  const runner = () => new JobRunner({ sql: h.sql, registry: h.registry, masumi: h.masumi, config: h.config });

  it("nothing runs before FundsLocked", async () => {
    expect((await start()).status).toBe(200);
    for (const state of ["WaitingForPayment", "RefundRequested", "Disputed", "Other"] as const) {
      h.masumi.state = state;
      await runner().tick();
    }
    expect(h.stub.hits()).toBe(0);
    expect(h.masumi.submitted).toHaveLength(0);
  });

  it("a failing answer is never submitted (the buyer is refunded)", async () => {
    const job = (await start()).body.job_id as string;
    h.masumi.state = "FundsLocked";
    for (const mode of ["empty", "stale", "error500", "html"] as const) {
      h.stub.setMode(mode);
      await runner().tick();
    }
    expect(h.masumi.submitted).toHaveLength(0);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/status`).query({ job_id: job })).body.status).toBe("failed");
  });

  it("two runners claiming the same paid job run upstream exactly once", async () => {
    await start();
    h.masumi.state = "FundsLocked";
    const submit = h.masumi.submitResult.bind(h.masumi);
    h.masumi.submitResult = async (id, hash) => { await new Promise((r) => setTimeout(r, 50)); await submit(id, hash); };
    const a = runner().tick();
    const b = runner().tick(); // both list the job as awaiting payment; claimJob lets only one run it
    await Promise.all([a, b]);
    expect(h.stub.hits()).toBe(1);
  });

  it("a second gateway instance never re-submits a result while the first is still submitting", async () => {
    await start();
    h.masumi.state = "FundsLocked";
    const submit = h.masumi.submitResult.bind(h.masumi);
    h.masumi.submitResult = async (id, hash) => { await new Promise((r) => setTimeout(r, 300)); await submit(id, hash); };
    const a = runner().tick(); // instance A: runs upstream, stores the output, then submits (slow node)
    await new Promise((r) => setTimeout(r, 150));
    await runner().tick(); // instance B: sees running + output_hash and submits too
    await a;
    expect(h.stub.hits()).toBe(1);
    expect(h.masumi.submitted).toHaveLength(1);
  });

  it("a job id is scoped to its API; start_job floods are rate limited", async () => {
    const job = (await start()).body.job_id as string;
    const other = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
    expect((await request(h.app).get(`/a/${other.apiId}/status`).query({ job_id: job })).status).toBe(404);
    const rs = [];
    for (let i = 0; i < 12; i++) rs.push((await start()).status);
    expect(rs.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect(h.masumi.created.length).toBeLessThanOrEqual(10);
  });
});
