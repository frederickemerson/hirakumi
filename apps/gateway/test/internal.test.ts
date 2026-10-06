import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { httpChallengePath } from "@hirakumi/core";
import { makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });

describe("internal auth", () => {
  it("401 without or with a wrong token", async () => {
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`)).status).toBe(401);
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set("authorization", "Bearer wrong")).status).toBe(401);
  });
});

describe("preview", () => {
  it("runs an unpaid test call, returns the result with a verdict and logs it", async () => {
    const r = await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: { symbol: "ADA" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 200, contentType: "application/json", verdict: { pass: true, reasons: [] } });
    expect(JSON.parse(r.body.body).symbol).toBe("ADA");
    const [c] = await h.sql<{ kind: string }[]>`select kind from calls`;
    expect(c.kind).toBe("preview");
  });
  it("400 on bad input, 504 on timeout", async () => {
    expect((await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: {} })).status).toBe(400);
    h.stub.setMode("slow");
    expect((await request(h.app).post(`/internal/preview/${h.seeded.apiId}/getPrice`).set(auth()).send({ input: { symbol: "ADA" } })).status).toBe(504);
  });
});

describe("challenge check", () => {
  const insertChallenge = (token: string) =>
    h.sql`insert into challenges (id, api_id, kind, token, expires_at) values (${`ch_${token}`}, ${h.seeded.apiId}, 'http', ${token}, now() + interval '30 minutes')`;
  const check = () => request(h.app).post(`/internal/challenge/${h.seeded.apiId}/check`).set(auth());

  it("passes once when the file matches, then the challenge is used up", async () => {
    await insertChallenge("tok-123");
    h.stub.setChallenge(httpChallengePath(h.seeded.apiId), "tok-123\n");
    const ok = await check();
    expect(ok.body).toEqual({ ok: true, triedUrl: `${h.stub.origin}${httpChallengePath(h.seeded.apiId)}`, detail: "Ownership file verified." });
    const [row] = await h.sql<{ consumed_at: Date | null; proof: { status: number } | null }[]>`select consumed_at, proof from challenges`;
    expect(row.consumed_at).not.toBeNull();
    expect(row.proof?.status).toBe(200);
    expect((await check()).body.ok).toBe(false);
  });
  it("explains a missing file and a wrong file with the exact URL tried", async () => {
    await insertChallenge("tok-456");
    const missing = await check();
    expect(missing.body).toMatchObject({ ok: false, triedUrl: `${h.stub.origin}${httpChallengePath(h.seeded.apiId)}` });
    expect(missing.body.detail).toMatch(/404/);
    h.stub.setChallenge(httpChallengePath(h.seeded.apiId), "something-else");
    expect((await check()).body.detail).toMatch(/do not match the challenge/);
  });
});

describe("reload and health", () => {
  it("reload drops cached prices", async () => {
    await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    await h.sql`update packs set price_micros = 5000000`;
    expect((await request(h.app).post(`/internal/apis/${h.seeded.apiId}/reload`).set(auth())).body).toEqual({ ok: true });
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`);
    expect(r.body.packs[0].price).toBe("5000000");
  });
  it("health reports state, last check and reasons", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "/price is missing" }]);
    const r = await request(h.app).get(`/internal/apis/${h.seeded.apiId}/health`).set(auth());
    expect(r.body).toMatchObject({ health: "healthy", lastReasons: ["getPrice: /price is missing"] });
    expect(r.body.checkedAt).toMatch(/^\d{4}-/);
  });
});
