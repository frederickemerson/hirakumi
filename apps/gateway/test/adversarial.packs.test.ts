// Adversarial review: direct-mode pack payments (x402), recovery and the reconciler.
// Every test asserts the SAFE behaviour, so a failing test is a demonstrated vulnerability.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { sha256Hex } from "@hirakumi/core";
import { Reconciler, USDM_PREPROD_UNIT, type ChainLookup } from "../src/reconcile";
import { makeHarness, seedLiveApi, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const packPath = (apiId = h.seeded.apiId, packId = h.seeded.packId) => `/a/${apiId}/packs/${packId}`;
const SECRET = "adversarial-recovery-secret-0123456789";

async function offer(apiId?: string, packId?: string) {
  const unpaid = await request(h.app).post(packPath(apiId, packId));
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { required, accepted: required.accepts[0]! };
}
async function header(payload: Record<string, unknown>, apiId?: string, packId?: string) {
  const { required, accepted } = await offer(apiId, packId);
  return encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload });
}
const post = (sig: string, o: { apiId?: string; packId?: string; recovery?: string | null } = {}) => {
  const r = request(h.app).post(packPath(o.apiId, o.packId)).set("PAYMENT-SIGNATURE", sig);
  return o.recovery === null ? r : r.set("x-hirakumi-recovery", o.recovery ?? sha256Hex(SECRET));
};
const callWith = (token: string, apiId = h.seeded.apiId) =>
  request(h.app).get(`/a/${apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${token}`);
const tokens = () => h.sql<{ status: string; tx_hash: string | null }[]>`select status, tx_hash from credit_tokens order by created_at`;
const paysSeller = (amount = "2000000", unit = USDM_PREPROD_UNIT): ChainLookup => async () => ({
  found: true, outputs: [{ address: h.seeded.payTo, amount: [{ unit: "lovelace", quantity: "1500000" }, { unit, quantity: amount }] }],
});

describe("adversarial: pack payment double-spend", () => {
  it("the same PAYMENT-SIGNATURE replayed 3x: one token, one settle", async () => {
    const sig = await header({ transaction: "tx-A", nonce: "1" });
    expect((await post(sig)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await post(sig)).status).toBe(409);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toHaveLength(1);
  });

  it("same tx, different nonce / extra payload field / reordered keys: no second pack", async () => {
    expect((await post(await header({ transaction: "tx-B", nonce: "1" }))).status).toBe(200);
    for (const payload of [{ transaction: "tx-B", nonce: "2" }, { nonce: "1", transaction: "tx-B", pad: "x" }, { nonce: "1", transaction: "tx-B" }]) {
      const r = await post(await header(payload));
      expect(r.status).toBe(409);
      expect(r.body.token).toBeUndefined();
    }
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toHaveLength(1);
  });

  it("10 concurrent purchases with the same tx (different payloads): exactly one token", async () => {
    const sigs = await Promise.all(Array.from({ length: 10 }, (_, i) => header({ transaction: "tx-C", nonce: String(i) })));
    const rs = await Promise.all(sigs.map((s) => post(s)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await tokens()).toHaveLength(1);
  });

  it("one tx cannot buy packs on two different APIs (another seller)", async () => {
    const other = await seedLiveApi(h.sql, h.stub.origin);
    expect((await post(await header({ transaction: "tx-D", nonce: "1" }))).status).toBe(200);
    const r = await post(await header({ transaction: "tx-D", nonce: "1" }, other.apiId, other.packId), { apiId: other.apiId, packId: other.packId });
    expect(r.status).toBe(409);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("a handler 4xx (bad recovery hash, unreadable tx) never settles and leaves no token", async () => {
    expect((await post(await header({ transaction: "tx-E", nonce: "1" }), { recovery: "not-hex" })).status).toBe(400);
    expect((await post(await header({ transaction: "unreadable", nonce: "1" }))).status).toBe(400);
    expect(h.facilitator.settleCalls).toBe(0);
    expect(await tokens()).toHaveLength(0);
  });
});

describe("adversarial: settlement failure, recovery and the reconciler", () => {
  it("settle failure: no usable token; replay can't re-settle; reconciler refuses wrong asset / underpay", async () => {
    h.facilitator.settleMode = "fail";
    const sig = await header({ transaction: "tx-F", nonce: "1" });
    const first = await post(sig);
    expect(first.status).toBe(402);
    expect(first.body.token).toBeUndefined();
    h.facilitator.settleMode = "success";
    const replay = await post(sig);
    expect(replay.status).toBe(409);
    expect(h.facilitator.settleCalls).toBe(1);
    for (const lookup of [paysSeller("2000000", "lovelace"), paysSeller("1999999"), async () => ({ found: false as const })]) {
      await new Reconciler({ sql: h.sql, lookup, minAgeSeconds: 0 }).tick();
    }
    expect((await tokens())[0]!.status).toBe("pending");
    const rec = await request(h.app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", sig).set("x-hirakumi-recovery-secret", SECRET);
    expect(rec.status).toBe(200);
    expect((await callWith(rec.body.token)).status).toBe(401);
  });

  it("recovery: wrong secret → 403, other API → 404, and old tokens die on rotation", async () => {
    const sig = await header({ transaction: "tx-G", nonce: "1" });
    const bought = await post(sig);
    expect(bought.status).toBe(200);
    expect((await request(h.app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", sig).set("x-hirakumi-recovery-secret", "guess")).status).toBe(403);
    const other = await seedLiveApi(h.sql, h.stub.origin);
    expect((await request(h.app).post(`${packPath(other.apiId, other.packId)}/recover`).set("PAYMENT-SIGNATURE", sig).set("x-hirakumi-recovery-secret", SECRET)).status).toBe(404);
    const rec = await request(h.app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", sig).set("x-hirakumi-recovery-secret", SECRET);
    expect((await callWith(bought.body.token)).status).toBe(401);
    expect((await callWith(rec.body.token)).status).toBe(200);
  });

  it("a plain x402 buyer (no X-Hirakumi-Recovery) whose settle timed out but landed can still get its paid pack", async () => {
    h.facilitator.settleMode = "fail"; // facilitator timeout; the tx still lands on-chain
    const sig = await header({ transaction: "tx-H", nonce: "1" });
    const res = await post(sig, { recovery: null });
    expect(res.status).toBe(402);
    expect(res.body.message).toContain("Do not pay again");
    // The payment lands: the reconciler activates the token for the seller's received funds.
    await new Reconciler({ sql: h.sql, lookup: paysSeller(), minAgeSeconds: 0 }).tick();
    expect((await tokens())[0]!.status).toBe("active");
    // The buyer follows the message: recover with the same signature (it never had a secret).
    const rec = await request(h.app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", sig);
    const token: string | undefined = res.body.token ?? rec.body.token;
    expect(token, "buyer paid 2 USDM but has no way to obtain the (now active) token").toBeDefined();
    expect((await callWith(token!)).status).toBe(200);
  });
});

describe("adversarial: health gating of pack sales", () => {
  it("a Down API (in memory or from the DB at boot) never offers or settles a pack", async () => {
    const down = await seedLiveApi(h.sql, h.stub.origin, { health: "down" });
    const r = await request(h.app).post(packPath(down.apiId, down.packId));
    expect(r.status).toBe(503);
    expect(r.headers["payment-required"]).toBeUndefined();
    // Payment attached anyway (a 402 obtained before the API went down).
    const sig = await header({ transaction: "tx-I", nonce: "1" });
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    expect((await post(sig)).status).toBe(503);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
  });

  it("a retired or unknown API / pack never takes payment", async () => {
    const sig = await header({ transaction: "tx-J", nonce: "1" });
    await h.sql`update apis set state = 'retired' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await post(sig)).status).toBe(404);
    expect((await post(sig, { packId: "pk_nope" })).status).toBe(404);
    expect(h.facilitator.settleCalls).toBe(0);
  });
});
