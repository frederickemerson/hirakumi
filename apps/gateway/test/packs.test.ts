import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;

async function offer() {
  const unpaid = await request(h.app).post(packPath());
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { unpaid, required, accepted: required.accepts[0] };
}
async function pay(nonce = "nonce-1") {
  const { required, accepted } = await offer();
  const header = encodePaymentSignatureHeader({
    x402Version: required.x402Version, resource: required.resource, accepted,
    payload: { transaction: "dGVzdA==", nonce },
  });
  return { header, res: await request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header) };
}
const tokens = () => h.sql<{ status: string; remaining: number; tx_hash: string | null; payer: string | null }[]>`
  select status, remaining, tx_hash, payer from credit_tokens`;

describe("pack offer", () => {
  it("402 offers tUSDM to the seller's verified address with pack metadata and l1Confirmations 0", async () => {
    const { unpaid, required, accepted } = await offer();
    expect(required.x402Version).toBe(2);
    expect(accepted).toMatchObject({ scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount: "2000000", payTo: h.seeded.payTo });
    expect(accepted.extra).toMatchObject({
      apiId: h.seeded.apiId, packId: h.seeded.packId, calls: 100, ruleHash: h.seeded.ruleHash,
      ruleUrl: `https://gw.test/r/${h.seeded.ruleHash}`, confirmationPolicy: { l1Confirmations: 0 },
    });
    expect(unpaid.body).toMatchObject({ error: "payment_required", calls: 100, ruleHash: h.seeded.ruleHash });
    expect(h.facilitator.verifyCalls).toBe(0);
  });
  it("404 for an unknown pack; 503 and no x402 offer when the API is Down", async () => {
    expect((await request(h.app).post(`/a/${h.seeded.apiId}/packs/pk_nope`)).status).toBe(404);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    const r = await request(h.app).post(packPath());
    expect(r.status).toBe(503);
    expect(r.headers["payment-required"]).toBeUndefined();
  });
});

describe("pack purchase", () => {
  it("pays, settles, activates the token via onAfterSettle, and the token buys calls", async () => {
    const { res } = await pay();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ credits: 100, apiId: h.seeded.apiId });
    expect(res.body.token).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toEqual([{ status: "active", remaining: 100, tx_hash: "ab".repeat(32), payer: "addr_test1qbuyer" }]);
    const call = await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${res.body.token}`);
    expect(call.status).toBe(200);
    expect(call.headers["x-credits-remaining"]).toBe("99");
  });
  it("settle failure leaves the token pending, the buyer never sees it, and it cannot be used", async () => {
    h.facilitator.settleMode = "fail";
    const { res } = await pay();
    expect(res.status).toBe(402);
    expect(res.body.token).toBeUndefined();
    expect(await tokens()).toEqual([{ status: "pending", remaining: 100, tx_hash: null, payer: null }]);
  });
  it("a replayed payment gets 409, mints no second token and is not settled twice", async () => {
    const first = await pay("same");
    expect(first.res.status).toBe(200);
    const replay = await request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", first.header);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("payment_already_used");
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toHaveLength(1);
  });
});
