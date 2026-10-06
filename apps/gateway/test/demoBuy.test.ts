import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PackPurchaseError } from "@hirakumi/buyer";
import { newId } from "@hirakumi/core";
import type { DemoBuyer } from "../src/deps";
import { createApp } from "../src/app";
import { insertActiveToken, makeHarness, type Harness } from "./helpers";

/** Stands in for the buyer library: records each purchase and mints a real credit token in the test DB. */
class FakeBuyer implements DemoBuyer {
  address = "addr_test1qdemobuyer";
  funds = { lovelace: 50_000_000n, usdmMicros: 20_000_000n };
  purchases: { url: string; amount: bigint }[] = [];
  recoverCalls: { url: string; signature: string | null; secret: string | null }[] = [];
  /** What the next purchase does after it is signed. */
  next: "ok" | "settlement_failed" | "refused_before_signing" = "ok";
  recoverAnswer: { status: number; body: unknown } | null = null;
  settleDelayMs = 0;
  constructor(private readonly h: () => Harness) {}

  async buyPack(url: string, expected: { amount: bigint }, hooks?: { onSigned?: () => void }) {
    this.purchases.push({ url, amount: expected.amount });
    if (this.next === "refused_before_signing") throw new Error("refusing to pay: amount mismatch");
    hooks?.onSigned?.();
    if (this.settleDelayMs) await new Promise((r) => setTimeout(r, this.settleDelayMs));
    if (this.next === "settlement_failed") throw new PackPurchaseError(402, '{"error":"settlement_failed"}', "SIGNED_PAYMENT", "BUYER_SECRET");
    const { token } = await insertActiveToken(this.h().sql, this.h().seeded, 100);
    return { token, credits: 100, txHash: "ab".repeat(32) };
  }
  async balance() { return this.funds; }
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const hd = new Headers(init?.headers);
    this.recoverCalls.push({ url, signature: hd.get("payment-signature"), secret: hd.get("x-hirakumi-recovery-secret") });
    const a = this.recoverAnswer ?? { status: 404, body: { error: "payment_not_found" } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
}

let h: Harness;
let buyer: FakeBuyer;
beforeEach(async () => {
  h = await makeHarness();
  buyer = new FakeBuyer(() => h);
  h.deps.demoBuyer = buyer;
  h.app = createApp(h.deps);
});
afterEach(async () => { await h.close(); });

const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });
const buy = (apiId = h.seeded.apiId) => request(h.app).post(`/internal/demo/buy-pack/${apiId}`).set(auth());
const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const rows = () => h.sql<{ status: string; created_at: Date }[]>`select status, created_at from try_tokens order by created_at`;

describe("POST /internal/demo/buy-pack/:apiId", () => {
  it("401 without the internal token, and never buys", async () => {
    expect((await request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`)).status).toBe(401);
    expect((await request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set("authorization", "Bearer nope")).status).toBe(401);
    expect(buyer.purchases).toEqual([]);
  });

  it("503 when the demo wallet is not configured", async () => {
    h.deps.demoBuyer = null;
    const r = await request(createApp(h.deps)).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set(auth());
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("buyer_not_configured");
  });

  it("buys the offered pack through the public URL and streams paying, settling, settled", async () => {
    const r = await buy();
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/x-ndjson/);
    const ev = events(r.text);
    expect(ev.map((e) => e.phase)).toEqual(["paying", "settling", "settled"]);
    expect(ev[0]).toMatchObject({ packId: h.seeded.packId, calls: 100, priceMicros: "2000000", wallet: "addr_test1qdemobuyer" });
    expect(ev[2]).toMatchObject({ txHash: "ab".repeat(32), credits: 100, recovered: false });
    expect(buyer.purchases).toEqual([{ url: `https://gw.test/a/${h.seeded.apiId}/packs/${h.seeded.packId}`, amount: 2_000_000n }]);
    const [row] = await h.sql<{ status: string; token: string; tx_hash: string; credits: number }[]>`select status, token, tx_hash, credits from try_tokens`;
    expect(row).toMatchObject({ status: "active", tx_hash: "ab".repeat(32), credits: 100 });
    expect(row.token).toMatch(/^hk_/);
  });

  it("reuses a pack that still has credits instead of buying again", async () => {
    await buy();
    const again = await buy();
    expect(again.status).toBe(200);
    expect(events(again.text)).toEqual([expect.objectContaining({ phase: "ready", credits: 100, txHash: "ab".repeat(32), pending: false })]);
    expect(buyer.purchases).toHaveLength(1);
  });

  it("allows one purchase per API per 10 minutes, even once the pack is used up", async () => {
    await buy();
    await h.sql`update credit_tokens set remaining = 0, status = 'exhausted'`;
    const r = await buy();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("api_cooldown");
    expect(r.body.message).toMatch(/last 10 minutes/);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(500);
    expect(buyer.purchases).toHaveLength(1);
  });

  it("allows 6 purchases per hour across all APIs", async () => {
    for (let i = 0; i < 6; i++) {
      await h.sql`insert into try_tokens (id, api_id, status, created_at) values (${newId("try")}, ${h.seeded.apiId}, 'failed', now() - interval '20 minutes')`;
    }
    const r = await buy();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("global_hourly");
    expect(r.body.message).toMatch(/6 purchases this hour/);
    expect(buyer.purchases).toEqual([]);
  });

  it("two clicks at once buy only one pack", async () => {
    buyer.settleDelayMs = 300; // both clicks are in flight while the first payment settles
    const [a, b] = await Promise.all([buy(), buy()]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(buyer.purchases).toHaveLength(1);
  });

  it("refuses a pack priced over 5 tUSDM and spends nothing", async () => {
    await h.sql`update packs set price_micros = 6000000`;
    const r = await buy();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "price_over_cap" });
    expect(r.body.message).toMatch(/5 tUSDM/);
    expect(buyer.purchases).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("refuses with a clear message when the wallet has under 3 tADA, and that refusal doesn't count", async () => {
    buyer.funds = { lovelace: 2_500_000n, usdmMicros: 20_000_000n };
    const r = await buy();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "low_funds",
      message: "The demo wallet has 2.5 tADA. It needs at least 3 tADA for fees, so nothing was bought.",
    });
    expect(buyer.purchases).toEqual([]);
    expect((await rows()).map((x) => x.status)).toEqual(["void"]);
    buyer.funds = { lovelace: 50_000_000n, usdmMicros: 20_000_000n };
    expect((await buy()).status).toBe(200);
  });

  it("refuses when the wallet can't pay the pack in tUSDM", async () => {
    buyer.funds = { lovelace: 50_000_000n, usdmMicros: 1_000_000n };
    const r = await buy();
    expect(r.status).toBe(409);
    expect(r.body.message).toBe("The demo wallet has 1 tUSDM and the pack costs 2, so nothing was bought.");
  });

  it("503 while the API is Down", async () => {
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    const r = await buy();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("api_down");
    expect(buyer.purchases).toEqual([]);
  });

  it("a payment refused before signing spends nothing and doesn't block the next try", async () => {
    buyer.next = "refused_before_signing";
    const r = await buy();
    expect(events(r.text).at(-1)).toMatchObject({ phase: "failed", spent: false });
    expect((await rows()).map((x) => x.status)).toEqual(["void"]);
    buyer.next = "ok";
    expect(events((await buy()).text).at(-1)).toMatchObject({ phase: "settled" });
  });

  it("saves a signed payment whose settlement failed, then recovers it with the recovery secret instead of paying again", async () => {
    buyer.next = "settlement_failed";
    const first = await buy();
    expect(events(first.text).map((e) => e.phase)).toEqual(["paying", "settling", "failed"]);
    expect(events(first.text).at(-1)).toMatchObject({ spent: true });
    expect((await rows()).map((x) => x.status)).toEqual(["unsettled"]);

    const { token } = await insertActiveToken(h.sql, h.seeded, 100);
    buyer.recoverAnswer = { status: 200, body: { token, status: "active", credits: 100 } };
    const second = await buy();
    expect(events(second.text)).toEqual([expect.objectContaining({ phase: "settled", recovered: true, credits: 100 })]);
    expect(buyer.recoverCalls).toEqual([{
      url: `https://gw.test/a/${h.seeded.apiId}/packs/${h.seeded.packId}/recover`, signature: "SIGNED_PAYMENT", secret: "BUYER_SECRET",
    }]);
    expect(buyer.purchases).toHaveLength(1);
    const [row] = await h.sql<{ status: string; recovery_secret: string | null }[]>`select status, recovery_secret from try_tokens`;
    expect(row).toEqual({ status: "active", recovery_secret: null });
  });
});
