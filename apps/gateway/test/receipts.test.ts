import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { outputHash } from "@hirakumi/core";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const call = (token: string) => request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
const receipts = (token?: string) => {
  const r = request(h.app).get(`/a/${h.seeded.apiId}/receipts`);
  return token ? r.set("authorization", `Bearer ${token}`) : r;
};

describe("GET /a/:apiId/receipts (a buyer checks their own pack history)", () => {
  it("lists every call made with the token, newest first, with verdict, charge, promise and hashes", async () => {
    const { token, id } = await insertActiveToken(h.sql, h.seeded, 10);
    const passed = await call(token);
    expect(passed.status).toBe(200);
    h.stub.setMode("stale");
    expect((await call(token)).status).toBe(422);

    const r = await receipts(token);
    expect(r.status).toBe(200);
    expect(r.body.token).toMatchObject({ id, status: "active", remaining: 9, packId: h.seeded.packId });
    expect(r.body.calls).toHaveLength(2);
    const [failed, ok] = r.body.calls;
    expect(failed).toMatchObject({ opId: "getPrice", verdict: "fail", charged: false, ruleHash: h.seeded.ruleHash });
    expect(failed.reasons.length).toBeGreaterThan(0);
    expect(ok).toMatchObject({ verdict: "pass", charged: true, ruleHash: h.seeded.ruleHash });
    // The buyer can recompute the output hash from the body they received (MIP-004 style, identifier = token id).
    expect(ok.outputHash).toBe(outputHash(id, passed.text));
    expect(r.body.verify).toContain("token.id");
  });

  it("needs the token: 401 without one or with an unknown one, and never shows another API's calls", async () => {
    expect((await receipts()).status).toBe(401);
    expect((await receipts("hk_nope")).status).toBe(401);
    const { token } = await insertActiveToken(h.sql, h.seeded, 5);
    expect((await request(h.app).get("/a/api_other/receipts").set("authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
