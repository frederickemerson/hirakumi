import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
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
