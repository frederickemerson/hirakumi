// PACK_MODE=hybrid: the policy picks direct or escrow per purchase, the 402 says which and why, and the paid
// retry always meets the same offer (x402 matches `extra` by deep equality).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { PACK_ESCROW, newReceiptKey } from "@hirakumi/escrow";
import { sha256Hex } from "@hirakumi/core";
import { getChannel } from "@hirakumi/db";
import { createApp } from "../src/app";
import { ChannelWatcher } from "../src/channelWatcher";
import type { GatewayConfig, PackEscrowConfig } from "../src/config";
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
const SECRET = "buyer-only-recovery-secret-0123456789";

let h: Harness;
let chain: FakeEscrowChain;
let key: { secretKey: string; publicKey: string };
let app: Harness["app"];

/** Default: a proven seller (listed 30 days ago, no downtime) selling 100 calls for 1 tUSDM (direct). */
async function setup(o: { config?: Partial<GatewayConfig>; chain?: boolean; price?: number; listedDaysAgo?: number } = {}) {
  chain = new FakeEscrowChain(true);
  h = await makeHarness({
    config: { packMode: "hybrid", packEscrow: ESCROW, upstreamTimeoutMs: 3_000, ...o.config },
    escrowChain: o.chain === false ? null : chain, facilitatorMethods: ["default", "script"],
  });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  await h.sql`update apis set created_at = now() - make_interval(secs => ${(o.listedDaysAgo ?? 30) * 86_400}) where id = ${h.seeded.apiId}`;
  await h.sql`update packs set price_micros = ${o.price ?? 1_000_000} where id = ${h.seeded.packId}`;
  h.registry.invalidate(h.seeded.apiId);
  forgetSettlementSignals(h.sql);
  key = newReceiptKey();
  app = h.app;
}
afterEach(async () => { await h.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
const callPath = () => `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`;
type Keys = { receiptKey: string; refundAddress: string } | null;
const keysOf = (): Keys => ({ receiptKey: key.publicKey, refundAddress: BUYER });
const withKeys = (r: request.Test, k: Keys) => k ? r.set("x-hirakumi-receipt-key", k.receiptKey).set("x-hirakumi-refund-address", k.refundAddress) : r;

async function offer(k: Keys = keysOf()) {
  const unpaid = await withKeys(request(app).post(packPath()), k);
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { unpaid, required, accepted: required.accepts[0]! };
}
const settlementOf = (a: PaymentRequirements) => (a.extra as { settlement?: unknown }).settlement;

/** Pays `accepted` (as a buyer echoes it) with `k`. For an escrow offer the fake chain shows the lock. */
async function pay(o: { required: { x402Version: number; resource?: unknown }; accepted: PaymentRequirements }, k: Keys = keysOf(), tx = `tx-${Math.random()}`) {
  const datum = (o.accepted.extra as { datum?: string }).datum;
  if (datum) chain.putLock(fakeTxHash(tx)!, datum, { tokens: BigInt(o.accepted.amount) });
  const header = encodePaymentSignatureHeader({
    x402Version: o.required.x402Version, resource: o.required.resource as never, accepted: o.accepted, payload: { transaction: tx, nonce: "n" },
  });
  const res = await withKeys(request(app).post(packPath()).set("PAYMENT-SIGNATURE", header).set("x-hirakumi-recovery", sha256Hex(SECRET)), k);
  return { res, header, tx };
}
const tokenCount = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from credit_tokens`)[0]!.n;
const downFor = (hours: number) => h.sql`
  insert into health_events (api_id, from_health, to_health, at) values
    (${h.seeded.apiId}, 'healthy', 'down', now() - make_interval(hours => ${hours + 1})),
    (${h.seeded.apiId}, 'down', 'healthy', now() - interval '1 hour')`;
/** The 60 s uptime cache would hide a change for a minute; tests that change data mid-purchase drop it. */
const freshSignals = () => forgetSettlementSignals(h.sql);

describe("hybrid offer: the policy's choice and its reasons in extra.settlement", () => {
  it("small pack, proven seller: direct to the seller", async () => {
    await setup();
    const { accepted, unpaid } = await offer();
    expect(accepted.payTo).toBe(SELLER);
    expect(settlementOf(accepted)).toEqual({ mode: "direct", reasons: ["small pack", "proven seller"] });
    expect(accepted.extra).not.toHaveProperty("datum");
    expect(unpaid.body).toMatchObject({ mode: "direct", settlement: { mode: "direct" } });
    expect(unpaid.body.message).toMatch(/^Settlement: direct, because: small pack, proven seller\./);
  });

  it("large pack: escrow at the script with the buyer's datum", async () => {
    await setup({ price: 2_000_000 });
    const { accepted, unpaid } = await offer();
    expect(accepted.payTo).toBe(PACK_ESCROW.address);
    expect(settlementOf(accepted)).toEqual({ mode: "escrow", reasons: ["large pack"] });
    expect(accepted.extra).toMatchObject({ assetTransferMethod: "script", channelId: expect.any(String), datum: expect.any(String) });
    expect(unpaid.body.message).toMatch(/^Settlement: escrow, because: large pack\./);
  });

  it("new listing and uptime below 99%: escrow, every reason listed", async () => {
    await setup({ listedDaysAgo: 3 });
    await downFor(2);
    const { accepted } = await offer();
    expect(settlementOf(accepted)).toEqual({ mode: "escrow", reasons: ["uptime below 99%", "new seller"] });
  });

  it("thresholds come from config", async () => {
    await setup({ price: 2_000_000, config: { settlement: { escrowFromMicros: 5_000_000n, minUptimePct: 99, minListingDays: 7 } } });
    expect(settlementOf((await offer()).accepted)).toMatchObject({ mode: "direct" });
  });

  it("(12) a plain x402 buyer (no escrow headers) gets direct and buys a working token", async () => {
    await setup({ price: 3_000_000, listedDaysAgo: 1 });
    const o = await offer(null);
    expect(o.accepted.payTo).toBe(SELLER);
    expect(settlementOf(o.accepted)).toEqual({ mode: "direct", reasons: ["buyer sent no receipt key"] });
    const { res } = await pay(o, null);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "direct", credits: 100 });
    expect((await request(app).get(callPath()).set("authorization", `Bearer ${res.body.token}`)).status).toBe(200);
    expect(await h.sql`select 1 from settlement_decisions`).toHaveLength(0);
  });

  it("malformed or half escrow headers: 400, no offer, no decision, no credit", async () => {
    await setup();
    const cases: [Record<string, string>, string][] = [
      [{ "x-hirakumi-receipt-key": "zz" }, "receipt_key_required"],
      [{ "x-hirakumi-refund-address": BUYER }, "receipt_key_required"],
      [{ "x-hirakumi-receipt-key": key.publicKey }, "bad_refund_address"],
      [{ "x-hirakumi-receipt-key": "00".repeat(32), "x-hirakumi-refund-address": BUYER }, "bad_receipt_key"],
      [{ "x-hirakumi-receipt-key": key.publicKey, "x-hirakumi-refund-address": "addr1qmainnet" }, "bad_refund_address"],
    ];
    for (const [headers, error] of cases) {
      const r = await request(app).post(packPath()).set(headers);
      expect(r.status, JSON.stringify(headers)).toBe(400);
      expect(r.body.error).toBe(error);
      expect(r.headers["payment-required"]).toBeUndefined();
    }
    expect(await h.sql`select 1 from settlement_decisions`).toHaveLength(0);
    expect(await tokenCount()).toBe(0);
    expect(h.facilitator.verifyCalls).toBe(0);
  });

  it("concurrent 402s for one buyer: one decision, one datum", async () => {
    await setup({ price: 2_000_000 });
    const offers = await Promise.all(Array.from({ length: 12 }, () => offer()));
    const extras = new Set(offers.map((o) => JSON.stringify(o.accepted.extra)));
    expect(extras.size).toBe(1);
    expect(await h.sql`select 1 from settlement_decisions`).toHaveLength(1);
  });

  it("(10) policy says escrow but this gateway can't escrow: direct, with escrow recommended", async () => {
    for (const o of [{ config: { packEscrow: null } }, { chain: false }] as const) {
      await setup({ price: 2_000_000, ...o });
      const { accepted } = await offer();
      expect(accepted.payTo).toBe(SELLER);
      expect(settlementOf(accepted)).toEqual({ mode: "direct", reasons: ["large pack"], recommended: "escrow" });
      const { res } = await pay(await offer());
      expect(res.status).toBe(200);
      await h.close();
    }
    await setup();
  });

  it("(10) a price that does not split per call can't be escrowed: direct, escrow recommended", async () => {
    await setup({ price: 2_000_001 });
    expect(settlementOf((await offer()).accepted)).toEqual({ mode: "direct", reasons: ["large pack"], recommended: "escrow" });
  });
});

describe("hybrid purchase", () => {
  it("direct: pays the seller, token active, no channel", async () => {
    await setup();
    const { res } = await pay(await offer());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "direct", credits: 100 });
    expect(res.body.channelId).toBeUndefined();
    expect(await h.sql`select 1 from pack_channels`).toHaveLength(0);
    expect((await request(app).get(callPath()).set("authorization", `Bearer ${res.body.token}`)).status).toBe(200);
  });

  it("escrow: opens the channel, the verified lock activates the token, calls need IOUs", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    const { res } = await pay(o);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "escrow", channelId: (o.accepted.extra as { channelId: string }).channelId });
    expect(await getChannel(h.sql, res.body.channelId)).toMatchObject({ status: "locked" });
    const r = await request(app).get(callPath()).set("authorization", `Bearer ${res.body.token}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-hirakumi-sign-next"]).toBe("1");
  });
});

describe("402 vs verify determinism: what changes between the offer and the payment", () => {
  it("(1) uptime drops below 99% after the 402: the paid retry keeps the stored decision (direct)", async () => {
    await setup();
    const o = await offer();
    expect(settlementOf(o.accepted)).toMatchObject({ mode: "direct" });
    await downFor(3);
    freshSignals();
    const { res } = await pay(o);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("direct");
    // A new buyer is decided on the new data.
    key = newReceiptKey();
    expect(settlementOf((await offer()).accepted)).toEqual({ mode: "escrow", reasons: ["uptime below 99%"] });
  });

  it("(1) the listing turns 7 days old after the 402: the paid retry keeps the stored decision (escrow)", async () => {
    await setup({ listedDaysAgo: 6.999 });
    const o = await offer();
    expect(settlementOf(o.accepted)).toEqual({ mode: "escrow", reasons: ["new seller"] });
    await h.sql`update apis set created_at = now() - interval '8 days' where id = ${h.seeded.apiId}`;
    freshSignals();
    const { res } = await pay(o);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("escrow");
    key = newReceiptKey();
    expect(settlementOf((await offer()).accepted)).toMatchObject({ mode: "direct" });
  });

  it("(1) uptime recovers above 99% after an escrow 402: still escrow for that buyer", async () => {
    await setup();
    await downFor(3);
    const o = await offer();
    expect(settlementOf(o.accepted)).toMatchObject({ mode: "escrow" });
    await h.sql`delete from health_events`;
    freshSignals();
    expect((await pay(o)).res.status).toBe(200);
  });

  it("(2) the seller edits the price after the 402: no match, nothing settled, no credit", async () => {
    await setup();
    const o = await offer();
    await h.sql`update packs set price_micros = 3000000 where id = ${h.seeded.packId}`;
    h.registry.invalidate(h.seeded.apiId);
    const { res } = await pay(o);
    expect(res.status).toBe(402);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
    // The new price is decided afresh (key includes the price): now a large pack.
    expect(settlementOf((await offer()).accepted)).toEqual({ mode: "escrow", reasons: ["large pack"] });
  });

  it("(2)(3) the pack is removed or the API retired after the 402: 404, nothing settled", async () => {
    await setup();
    const o = await offer();
    await h.sql`update apis set state = 'retired' where id = ${h.seeded.apiId}`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await pay(o)).res.status).toBe(404);
    await h.sql`update apis set state = 'live' where id = ${h.seeded.apiId}`;
    await h.sql`insert into packs (id, api_id, calls, price_micros, escrow_price_micros) values ('pk_other', ${h.seeded.apiId}, 10, 1000000, 1000000)`;
    await h.sql`delete from settlement_decisions`;
    await h.sql`delete from packs where id = ${h.seeded.packId}`;
    h.registry.invalidate(h.seeded.apiId);
    expect((await pay(o)).res.status).toBe(404);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it("(3) the API goes Down after the 402: 503, nothing settled", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    h.health.record(h.seeded.apiId, false, [{ op: "getPrice", reason: "x" }]);
    const { res } = await pay(o);
    expect(res.status).toBe(503);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it("(4) thresholds change across a restart: the stored decision still answers the paid retry", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    expect(settlementOf(o.accepted)).toMatchObject({ mode: "escrow" });
    app = createApp({ ...h.deps, config: { ...h.config, settlement: { escrowFromMicros: 10_000_000n, minUptimePct: 0, minListingDays: 0 } } });
    const { res } = await pay(o);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("escrow");
  });

  it("(4) PACK_MODE changes across a restart: an escrow offer paid to a direct gateway is refused, unsettled", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    app = createApp({ ...h.deps, config: { ...h.config, packMode: "direct", packEscrow: null } });
    const { res } = await pay(o);
    expect(res.status).toBe(402);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it("(4) a direct gateway's offer paid after a switch to hybrid is refused (settlement is now required), unsettled", async () => {
    await setup();
    app = createApp({ ...h.deps, config: { ...h.config, packMode: "direct", packEscrow: null } });
    const o = await offer();
    app = h.app;
    const { res } = await pay(o);
    expect(res.status).toBe(402);
    expect(await tokenCount()).toBe(0);
  });

  it("(5) paying direct when escrow was decided, or escrow when direct was: refused before verify, nothing settled", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    const asDirect = { ...o.accepted, payTo: SELLER, extra: { ...(o.accepted.extra as object), settlement: { mode: "direct", reasons: ["small pack", "proven seller"] } } };
    expect((await pay({ ...o, accepted: asDirect })).res.status).toBe(402);
    const sameExtraOtherPayTo = { ...o.accepted, payTo: SELLER };
    expect((await pay({ ...o, accepted: sameExtraOtherPayTo })).res.status).toBe(402);
    await h.close();
    await setup();
    const d = await offer();
    const asEscrow = { ...d.accepted, payTo: PACK_ESCROW.address, extra: { ...(d.accepted.extra as object), settlement: { mode: "escrow", reasons: ["large pack"] } } };
    expect((await pay({ ...d, accepted: asEscrow })).res.status).toBe(402);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it("(6) the buyer drops or changes its keys between the 402 and the payment: refused, nothing settled", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    expect((await pay(o, null)).res.status).toBe(402);
    expect((await pay(o, { receiptKey: newReceiptKey().publicKey, refundAddress: BUYER })).res.status).toBe(402);
    expect((await pay(o, { receiptKey: "bad", refundAddress: BUYER })).res.status).toBe(400);
    await h.close();
    await setup();
    const d = await offer();
    // A direct offer to a buyer with keys carries its reasons; without keys the reasons differ.
    expect((await pay(d, null)).res.status).toBe(402);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it("(7) a replayed payment is refused in both modes (direct 409; escrow 402, its quote is spent), settled once", async () => {
    for (const price of [1_000_000, 2_000_000]) {
      await setup({ price });
      const first = await pay(await offer());
      expect(first.res.status).toBe(200);
      const replay = await withKeys(request(app).post(packPath()).set("PAYMENT-SIGNATURE", first.header), keysOf());
      expect(replay.status).toBe(price === 1_000_000 ? 409 : 402);
      expect(h.facilitator.settleCalls).toBe(1);
      expect(await tokenCount()).toBe(1);
      await h.close();
    }
    await setup();
  });

  it("(7) one buyer races two payments for one escrow quote: one channel; the other is refused and never settled", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    const [a, b] = await Promise.all([pay(o), pay(o)]);
    // The loser meets a spent quote: 402 (fresh quote, no match) or 409 (quote_not_found). Either way it never settles.
    expect([a.res.status, b.res.status].sort()[0]).toBe(200);
    expect([402, 409]).toContain([a.res.status, b.res.status].sort()[1]);
    expect(await h.sql`select 1 from pack_channels`).toHaveLength(1);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("(7) one buyer races two direct purchases: two payments, two tokens (both paid)", async () => {
    await setup();
    const o = await offer();
    const [a, b] = await Promise.all([pay(o), pay(o)]);
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    expect(await tokenCount()).toBe(2);
  });

  it("(8) decision and quote expired before a late payment: escrow is refused unsettled; direct re-decides the same and goes through", async () => {
    await setup({ price: 2_000_000 });
    const o = await offer();
    await h.sql`update settlement_decisions set expires_at = now() - interval '1 second'`;
    await h.sql`update pack_quotes set expires_at = now() - interval '1 second'`;
    const late = await pay(o);
    expect(late.res.status).toBe(402);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
    await h.close();
    await setup();
    const d = await offer();
    await h.sql`update settlement_decisions set expires_at = now() - interval '1 second'`;
    expect((await pay(d)).res.status).toBe(200);
  });

  it("(9) direct: settlement fails, the token stays pending, /recover re-issues it", async () => {
    await setup();
    h.facilitator.settleMode = "fail";
    const { res, header } = await pay(await offer());
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("settlement_failed");
    const rec = await request(app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", header).set("x-hirakumi-recovery-secret", SECRET);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ status: "pending", credits: 100 });
  });

  it("(9) escrow: settlement times out while the lock lands; the watcher verifies it and /recover re-issues the token", async () => {
    await setup({ price: 2_000_000 });
    h.facilitator.settleMode = "fail";
    const o = await offer();
    const { res, header, tx } = await pay(o);
    expect(res.status).toBe(402);
    const channelId = (o.accepted.extra as { channelId: string }).channelId;
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "pending", lock_tx_hash: fakeTxHash(tx) });
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "locked" });
    const rec = await request(app).post(`${packPath()}/recover`).set("PAYMENT-SIGNATURE", header).set("x-hirakumi-recovery-secret", SECRET);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ status: "active", credits: 100 });
  });
});

describe("fixed modes are unchanged", () => {
  it("PACK_MODE=direct: no settlement in extra, ignores escrow headers", async () => {
    await setup({ config: { packMode: "direct", packEscrow: null }, price: 2_000_000 });
    const { accepted, unpaid } = await offer();
    expect(accepted.payTo).toBe(SELLER);
    expect(accepted.extra).not.toHaveProperty("settlement");
    expect(unpaid.body).not.toHaveProperty("settlement");
  });

  it("PACK_MODE=escrow: escrow for a small pack too, no settlement in extra, keys required", async () => {
    await setup({ config: { packMode: "escrow" } });
    const { accepted } = await offer();
    expect(accepted.payTo).toBe(PACK_ESCROW.address);
    expect(accepted.extra).not.toHaveProperty("settlement");
    expect((await request(app).post(packPath())).status).toBe(400);
  });
});

describe("GET /internal/apis/:apiId/settlement (the public API page)", () => {
  const get = () => request(app).get(`/internal/apis/${h.seeded.apiId}/settlement`).set("authorization", `Bearer ${h.config.internalToken}`);
  it("hybrid: the policy for a buyer who can escrow, per pack", async () => {
    await setup({ listedDaysAgo: 2 });
    expect((await get()).body).toEqual({ packMode: "hybrid", packs: [{ packId: h.seeded.packId, mode: "escrow", reasons: ["new seller"] }] });
  });
  it("hybrid without escrow: direct, escrow recommended; fixed modes: no reasons; needs the internal token", async () => {
    await setup({ price: 2_000_000, config: { packEscrow: null } });
    expect((await get()).body.packs[0]).toEqual({ packId: h.seeded.packId, mode: "direct", reasons: ["large pack"], recommended: "escrow" });
    app = createApp({ ...h.deps, config: { ...h.config, packMode: "direct" } });
    expect((await get()).body.packs[0]).toEqual({ packId: h.seeded.packId, mode: "direct", reasons: [] });
    expect((await request(app).get(`/internal/apis/${h.seeded.apiId}/settlement`)).status).toBe(401);
  });
});
