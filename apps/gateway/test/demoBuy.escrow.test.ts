import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { PackPurchaseError, type OfferCheck, type SignedHook } from "@hirakumi/buyer";
import { decodePackDatum, signReceipt, verifyReceipt } from "@hirakumi/escrow";
import { createApp } from "../src/app";
import type { PackEscrowConfig } from "../src/config";
import type { DemoBuyer } from "../src/deps";
import { FakeEscrowChain } from "./fakeChain";
import { fakeTxHash, makeHarness, type Harness } from "./helpers";

// Real preprod-shaped addresses (golden vectors in packages/escrow/test/golden.ts).
const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
const ESCROW: PackEscrowConfig = {
  feeAddress: FEE, feeBps: 300, closerVkh: "c1".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000,
  operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};

/**
 * Stands in for the buyer library's buyEscrowPack, but against the real gateway: asks for the 402 with our
 * keys, runs the caller's datum check, fires onSigned, then pays the offered lock (the fake chain shows it).
 */
class EscrowBuyer implements DemoBuyer {
  address = BUYER;
  funds = { lovelace: 50_000_000n, usdmMicros: 20_000_000n };
  /** "tamper": the 402 offer is altered before the check sees it (another refund address). */
  mode: "ok" | "tamper" = "ok";
  purchases = 0;
  constructor(private readonly h: () => Harness, private readonly chain: FakeEscrowChain) {}
  async buyPack(): Promise<never> { throw new Error("escrow mode never buys a direct pack"); }
  async balance() { return this.funds; }
  fetch = async (): Promise<Response> => new Response("{}", { status: 404 });
  async buyEscrowPack(url: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck, hooks?: { onSigned?: SignedHook }) {
    this.purchases += 1;
    const path = new URL(url).pathname;
    const withKeys = (r: request.Test) => r.set("x-hirakumi-receipt-key", keys.receiptKey).set("x-hirakumi-refund-address", keys.refundAddress);
    const unpaid = await withKeys(request(this.h().app).post(path));
    const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
    const accepted = required.accepts[0]!;
    const shown = this.mode === "tamper" ? { ...accepted, payTo: SELLER } : accepted;
    check(shown as Parameters<OfferCheck>[0]);
    await hooks?.onSigned?.({ paymentSignature: "SIGNED_LOCK", recoverySecret: "BUYER_SECRET" });
    const transaction = `lock-${Math.random()}`;
    this.chain.putLock(fakeTxHash(transaction)!, String((accepted.extra as { datum: string }).datum));
    const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
    const paid = await withKeys(request(this.h().app).post(path).set("PAYMENT-SIGNATURE", header));
    if (paid.status !== 200) throw new PackPurchaseError(paid.status, JSON.stringify(paid.body), "SIGNED_LOCK", "BUYER_SECRET");
    return { token: paid.body.token, credits: paid.body.credits, apiId: paid.body.apiId, txHash: fakeTxHash(transaction), channelId: paid.body.channelId, channelUrl: paid.body.channelUrl };
  }
}

let h: Harness;
let chain: FakeEscrowChain;
let buyer: EscrowBuyer;
beforeEach(async () => {
  chain = new FakeEscrowChain(true);
  h = await makeHarness({ config: { packMode: "escrow", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  buyer = new EscrowBuyer(() => h, chain);
  h.deps.demoBuyer = buyer;
  h.config.tryLiveApis = [h.seeded.apiId];
  h.app = createApp(h.deps);
});
afterEach(async () => { await h.close(); });

const buy = () => request(h.app).post(`/internal/demo/buy-pack/${h.seeded.apiId}`).set("authorization", `Bearer ${h.config.internalToken}`);
const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("POST /internal/demo/buy-pack/:apiId with PACK_MODE=escrow", () => {
  it("locks an escrow pack with a fresh IOU key and keeps the channel and key on the row", async () => {
    const r = await buy();
    expect(r.status).toBe(200);
    const ev = events(r.text);
    expect(ev.map((e) => e.phase)).toEqual(["paying", "settling", "settled"]);
    expect(ev[0]).toMatchObject({ escrow: true, calls: 100, priceMicros: "2000000" });

    const [row] = await h.sql<{ status: string; token: string; channel_id: string; iou_secret: string; rule_hash: string }[]>`
      select status, token, channel_id, iou_secret, rule_hash from try_tokens`;
    expect(row.status).toBe("active");
    const [channel] = await h.sql<{ receipt_key: string; refund_address: string; datum_cbor: string }[]>`
      select receipt_key, refund_address, datum_cbor from pack_channels where channel_id = ${row.channel_id}`;
    // The stored secret signs IOUs that verify against the key the datum names; refunds go to the demo wallet.
    expect(verifyReceipt(channel.receipt_key, row.channel_id, 1, signReceipt(row.iou_secret, row.channel_id, 1))).toBe(true);
    expect(channel.refund_address).toBe(BUYER);
    expect(`sha256:${decodePackDatum(channel.datum_cbor).ruleHash}`).toBe(row.rule_hash);
  });

  it("reuses the open escrow pack, and buys again once its channel is closing", async () => {
    await buy();
    expect(events((await buy()).text)).toEqual([expect.objectContaining({ phase: "ready", credits: 100 })]);
    await h.sql`update pack_channels set status = 'close_requested'`;
    await h.sql`update try_tokens set created_at = now() - interval '1 hour'`; // past the per-API cooldown
    const again = await buy();
    expect(events(again.text).map((e) => e.phase)).toEqual(["paying", "settling", "settled"]);
    expect(buyer.purchases).toBe(2);
  });

  it("never pays an offer that fails the datum check, and spends nothing", async () => {
    buyer.mode = "tamper";
    const r = await buy();
    const ev = events(r.text);
    expect(ev.at(-1)).toMatchObject({ phase: "failed", spent: false });
    const [row] = await h.sql<{ status: string; channel_id: string | null }[]>`select status, channel_id from try_tokens`;
    expect(row).toEqual({ status: "void", channel_id: null });
    expect((await h.sql`select 1 from pack_channels`).length).toBe(0);
  });
});
