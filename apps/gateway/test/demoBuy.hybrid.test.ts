// Try it live under PACK_MODE=hybrid: the demo wallet asks with escrow headers like any agent and follows the
// 402's settlement. Direct and escrow purchases both stream the decision and its reasons.
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { PackPurchaseError, type OfferCheck, type SignedHook } from "@hirakumi/buyer";
import { PACK_ESCROW } from "@hirakumi/escrow";
import { newId } from "@hirakumi/core";
import { createApp } from "../src/app";
import type { PackEscrowConfig } from "../src/config";
import type { DemoBuyer } from "../src/deps";
import { forgetSettlementSignals } from "../src/settlement";
import { FakeEscrowChain } from "./fakeChain";
import { fakeTxHash, makeHarness, type Harness } from "./helpers";

const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
const ESCROW: PackEscrowConfig = {
  feeAddress: FEE, feeBps: 300, closerVkh: "c1".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000,
  operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};

/** The buyer library's buyEscrowPack against the real gateway: our keys on both requests, the check, then pay. */
class HybridBuyer implements DemoBuyer {
  address = BUYER;
  funds = { lovelace: 50_000_000n, usdmMicros: 20_000_000n };
  purchases = 0;
  constructor(private readonly h: () => Harness, private readonly chain: FakeEscrowChain) {}
  async buyPack(): Promise<never> { throw new Error("hybrid buys with escrow headers"); }
  async balance() { return this.funds; }
  fetch = async (): Promise<Response> => new Response("{}", { status: 404 });
  async buyEscrowPack(url: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck, hooks?: { onSigned?: SignedHook }) {
    this.purchases += 1;
    const path = new URL(url).pathname;
    const withKeys = (r: request.Test) => r.set("x-hirakumi-receipt-key", keys.receiptKey).set("x-hirakumi-refund-address", keys.refundAddress);
    const unpaid = await withKeys(request(this.h().app).post(path));
    const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
    const accepted = required.accepts[0]!;
    check(accepted as Parameters<OfferCheck>[0]);
    await hooks?.onSigned?.({ paymentSignature: "SIGNED", recoverySecret: "SECRET" });
    const transaction = `pay-${Math.random()}`;
    const escrow = accepted.payTo === PACK_ESCROW.address;
    if (escrow) this.chain.putLock(fakeTxHash(transaction)!, String((accepted.extra as { datum: string }).datum));
    const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
    const paid = await withKeys(request(this.h().app).post(path).set("PAYMENT-SIGNATURE", header));
    if (paid.status !== 200) throw new PackPurchaseError(paid.status, JSON.stringify(paid.body), "SIGNED", "SECRET");
    return {
      token: paid.body.token, credits: paid.body.credits, apiId: paid.body.apiId, txHash: fakeTxHash(transaction),
      mode: escrow ? "escrow" as const : "direct" as const, channelId: escrow ? paid.body.channelId : null, channelUrl: null,
    };
  }
}

let h: Harness;
let chain: FakeEscrowChain;
let buyer: HybridBuyer;
async function setup(o: { listedDaysAgo: number; price?: number }) {
  chain = new FakeEscrowChain(true);
  h = await makeHarness({ config: { packMode: "hybrid", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  await h.sql`update apis set created_at = now() - make_interval(days => ${o.listedDaysAgo}) where id = ${h.seeded.apiId}`;
  await h.sql`update packs set price_micros = ${o.price ?? 1_000_000} where id = ${h.seeded.packId}`;
  h.registry.invalidate(h.seeded.apiId);
  forgetSettlementSignals(h.sql);
  buyer = new HybridBuyer(() => h, chain);
  h.deps.demoBuyer = buyer;
  h.config.tryLiveApis = [h.seeded.apiId];
  h.app = createApp(h.deps);
}
afterEach(async () => { await h.close(); });

const buy = () => request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set("authorization", `Bearer ${h.config.internalToken}`);
const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("POST /internal/demo/buy-pack/:apiId with PACK_MODE=hybrid", () => {
  it("(11) proven seller, small pack: settles direct, says why, no channel kept", async () => {
    await setup({ listedDaysAgo: 30 });
    const r = await buy();
    const ev = events(r.text);
    expect(ev.map((e) => e.phase)).toEqual(["paying", "settling", "settled"]);
    expect(ev[1]).toEqual({ phase: "settling", settlement: { mode: "direct", reasons: ["small pack", "proven seller"] } });
    const [row] = await h.sql<{ status: string; channel_id: string | null; iou_secret: string | null; token: string }[]>`
      select status, channel_id, iou_secret, token from try_tokens`;
    expect(row).toMatchObject({ status: "active", channel_id: null, iou_secret: null });
    expect(await h.sql`select 1 from pack_channels`).toHaveLength(0);
    expect((await request(h.app).get(`/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`).set("authorization", `Bearer ${row.token}`)).status).toBe(200);
  });

  it("(11) new seller: escrow, with the channel and IOU key kept on the row", async () => {
    await setup({ listedDaysAgo: 1 });
    const ev = events((await buy()).text);
    expect(ev[1]).toEqual({ phase: "settling", settlement: { mode: "escrow", reasons: ["new seller"] } });
    const [row] = await h.sql<{ status: string; channel_id: string | null; iou_secret: string | null }[]>`
      select status, channel_id, iou_secret from try_tokens`;
    expect(row.status).toBe("active");
    expect(row.channel_id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.iou_secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(11) the per-API cooldown and the hourly cap still hold, whatever the settlement", async () => {
    await setup({ listedDaysAgo: 30 });
    await buy();
    await h.sql`update credit_tokens set remaining = 0, status = 'exhausted'`;
    const r = await buy();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("api_cooldown");
    await h.sql`update try_tokens set created_at = now() - interval '20 minutes'`;
    for (let i = 0; i < 5; i++) {
      await h.sql`insert into try_tokens (id, api_id, status, created_at) values (${newId("try")}, ${h.seeded.apiId}, 'failed', now() - interval '20 minutes')`;
    }
    const r2 = await buy();
    expect(r2.status).toBe(429);
    expect(r2.body.error).toBe("global_hourly");
    expect(buyer.purchases).toBe(1);
  });

  it("(11) a pack over the demo's 5 tUSDM cap is refused before any wallet work", async () => {
    await setup({ listedDaysAgo: 30, price: 6_000_000 });
    const r = await buy();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("price_over_cap");
    expect(buyer.purchases).toBe(0);
  });
});
