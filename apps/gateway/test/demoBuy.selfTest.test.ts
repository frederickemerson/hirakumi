import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { newId } from "@hirakumi/core";
import { reserveTryPurchase } from "@hirakumi/db";
import type { DemoBuyer } from "../src/deps";
import { createApp } from "../src/app";
import { TRY_LIMITS } from "../src/demoBuy";
import { anotherBase, insertActiveToken, makeHarness, seedLiveApi, type Harness } from "./helpers";

/** Stands in for the buyer library: mints a real credit token for the API it is asked to buy for. */
class FakeBuyer implements DemoBuyer {
  address = "addr_test1qdemobuyer";
  purchases: string[] = [];
  settleDelayMs = 0;
  constructor(private readonly h: () => Harness) {}
  async buyPack(url: string, _expected: { amount: bigint }, hooks?: { onSigned?: (s: { paymentSignature: string; recoverySecret: string }) => void | Promise<void> }) {
    this.purchases.push(url);
    await hooks?.onSigned?.({ paymentSignature: "SIGNED", recoverySecret: "SECRET" });
    if (this.settleDelayMs) await new Promise((r) => setTimeout(r, this.settleDelayMs));
    const apiId = /\/a\/([^/]+)\//.exec(url)![1];
    const [pack] = await this.h().sql<{ id: string }[]>`select id from packs where api_id = ${apiId}`;
    const { token } = await insertActiveToken(this.h().sql, { ...this.h().seeded, apiId, packId: pack.id }, 100);
    return { token, credits: 100, txHash: "cd".repeat(32) };
  }
  async buyEscrowPack(): Promise<never> { throw new Error("direct mode only"); }
  async balance() { return { lovelace: 50_000_000n, usdmMicros: 20_000_000n }; }
  fetch = async (): Promise<Response> => new Response("{}", { status: 404 });
}

let h: Harness;
let buyer: FakeBuyer;
beforeEach(async () => {
  h = await makeHarness();
  buyer = new FakeBuyer(() => h);
  h.deps.demoBuyer = buyer;
  h.config.tryLiveApis = []; // a seller's free test works for any live API, not only the showcase
  h.app = createApp(h.deps);
});
afterEach(async () => { await h.close(); });

const auth = () => ({ authorization: `Bearer ${h.config.internalToken}` });
const selfTest = (apiId = h.seeded.apiId) => request(h.app).post(`/internal/demo/self-test/${apiId}`).set(auth());

/** Another live API of the same seller, on its own base. */
async function anotherApi(): Promise<string> {
  const s = await seedLiveApi(h.sql, h.stub.origin, { pathPrefix: anotherBase() });
  await h.sql`update apis set seller_id = ${h.seeded.sellerId} where id = ${s.apiId}`;
  h.registry.invalidate(s.apiId);
  return s.apiId;
}

describe("POST /internal/demo/self-test/:apiId", () => {
  it("401 without the internal token", async () => {
    expect((await request(h.app).post(`/internal/demo/self-test/${h.seeded.apiId}`)).status).toBe(401);
    expect(buyer.purchases).toEqual([]);
  });

  it("buys a free test for an API outside TRY_LIVE_APIS and records it for the API's own seller", async () => {
    expect((await request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set(auth())).status).toBe(403);
    const r = await selfTest();
    expect(r.status).toBe(200);
    expect(r.text).toContain('"phase":"settled"');
    const [row] = await h.sql<{ selfTestSellerId: string | null; status: string }[]>`select self_test_seller_id as "selfTestSellerId", status from try_tokens`;
    expect(row).toEqual({ selfTestSellerId: h.seeded.sellerId, status: "active" });
  });

  it("reuses the free pack while it has credits, then refuses a second free test for the same listing", async () => {
    await selfTest();
    const again = await selfTest();
    expect(again.text).toContain('"phase":"ready"');
    await h.sql`update credit_tokens set remaining = 0, status = 'exhausted'`;
    const r = await selfTest();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("free_test_used");
    expect(buyer.purchases).toHaveLength(1);
  });

  it("two clicks at once buy one free test", async () => {
    buyer.settleDelayMs = 200;
    const [a, b] = await Promise.all([selfTest(), selfTest()]);
    expect(buyer.purchases).toHaveLength(1);
    const texts = [a.text, b.text].join("\n");
    expect(texts).toContain('"phase":"settled"');
  });

  it("caps free tests per seller across listings, under concurrency", async () => {
    const ids = [await anotherApi(), await anotherApi(), await anotherApi(), await anotherApi()];
    const results = await Promise.all(ids.map((id) => selfTest(id)));
    expect(buyer.purchases).toHaveLength(TRY_LIMITS.freeTestsPerSeller!);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(1);
    expect(refused[0].body.error).toBe("free_test_seller_cap");
  });

  it("a void attempt (nothing spent) frees the listing's slot", async () => {
    await h.sql`insert into try_tokens (id, api_id, status, self_test_seller_id) values (${newId("try")}, ${h.seeded.apiId}, 'void', ${h.seeded.sellerId})`;
    expect((await selfTest()).status).toBe(200);
  });

  it("the database refuses a second free test for a listing even without the lock", async () => {
    await h.sql`insert into try_tokens (id, api_id, status, self_test_seller_id) values (${newId("try")}, ${h.seeded.apiId}, 'failed', ${h.seeded.sellerId})`;
    await expect(h.sql`insert into try_tokens (id, api_id, status, self_test_seller_id) values (${newId("try")}, ${h.seeded.apiId}, 'buying', ${h.seeded.sellerId})`)
      .rejects.toThrow(/try_tokens_one_free_test/);
  });

  it("free tests still count toward the global demo limits", async () => {
    for (let i = 0; i < TRY_LIMITS.globalPerHour; i++) {
      await h.sql`insert into try_tokens (id, api_id, status, created_at) values (${newId("try")}, ${h.seeded.apiId}, 'failed', now() - interval '20 minutes')`;
    }
    const r = await selfTest();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("global_hourly");
  });

  it("the showcase never reuses a seller's free test pack", async () => {
    await selfTest();
    h.config.tryLiveApis = [h.seeded.apiId];
    const r = await request(createApp(h.deps)).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set(auth());
    expect(r.text).not.toContain('"phase":"ready"');
    expect(buyer.purchases).toHaveLength(2);
  });

  it("reserveTryPurchase alone enforces the per-seller cap", async () => {
    const ids = [await anotherApi(), await anotherApi(), await anotherApi()];
    for (const apiId of ids) {
      const ok = await reserveTryPurchase(h.sql, { id: newId("try"), apiId, packId: h.seeded.packId, priceMicros: "2000000", limits: TRY_LIMITS, scope: { selfTestSellerId: h.seeded.sellerId } });
      expect(ok.ok).toBe(true);
    }
    const r = await reserveTryPurchase(h.sql, { id: newId("try"), apiId: h.seeded.apiId, packId: h.seeded.packId, priceMicros: "2000000", limits: TRY_LIMITS, scope: { selfTestSellerId: h.seeded.sellerId } });
    expect(r).toEqual({ ok: false, reason: "free_test_seller_cap" });
  });
});
