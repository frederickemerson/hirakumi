import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { PACK_ESCROW, decodePackDatum, newReceiptKey, signReceipt } from "@hirakumi/escrow";
import { sha256Hex } from "@hirakumi/core";
import { getChannel } from "@hirakumi/db";
import { ChannelWatcher } from "../src/channelWatcher";
import type { PackEscrowConfig } from "../src/config";
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

let h: Harness;
let chain: FakeEscrowChain;
let key: { secretKey: string; publicKey: string };

async function setup(o: { allowance?: number; operator?: boolean } = {}) {
  chain = new FakeEscrowChain(o.operator ?? true);
  h = await makeHarness({ config: { packMode: "escrow", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  if (o.allowance) await h.sql`update packs set unsigned_allowance = ${o.allowance} where id = ${h.seeded.packId}`;
  key = newReceiptKey();
}
afterEach(async () => { await h.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
const callPath = () => `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`;
const asBuyer = (r: request.Test, k = key.publicKey, refund = BUYER) =>
  r.set("x-hirakumi-receipt-key", k).set("x-hirakumi-refund-address", refund);

async function offer(k = key.publicKey) {
  const unpaid = await asBuyer(request(h.app).post(packPath()), k);
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { unpaid, required, accepted: required.accepts[0]! };
}

/** Pays; `lock` decides what the fake chain shows for the payment tx. */
async function buy(lock: "good" | "extra_assets" | "none" = "good") {
  const { required, accepted } = await offer();
  const transaction = `lock-${Math.random()}`;
  const txHash = fakeTxHash(transaction)!;
  const datum = String((accepted.extra as { datum: string }).datum);
  if (lock === "good") chain.putLock(txHash, datum);
  if (lock === "extra_assets") chain.putLock(txHash, datum, { extraAssets: { ["ab".repeat(28) + "01"]: 1n } });
  const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
  const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header)).set("x-hirakumi-recovery", sha256Hex("secret"));
  return { res, txHash, channelId: String((accepted.extra as { channelId: string }).channelId) };
}

const call = (token: string, iou?: string) => {
  const r = request(h.app).get(callPath()).set("authorization", `Bearer ${token}`);
  return iou ? r.set("x-hirakumi-iou", iou) : r;
};
const iou = (channelId: string, n: number) => `${n}.${signReceipt(key.secretKey, channelId, n)}`;

describe("escrow pack offer", () => {
  beforeEach(async () => { await setup(); });

  it("offers the escrow script with an inline datum built from the buyer's headers", async () => {
    const { accepted, unpaid } = await offer();
    expect(accepted.payTo).toBe(PACK_ESCROW.address);
    const extra = accepted.extra as Record<string, unknown>;
    expect(extra).toMatchObject({ assetTransferMethod: "script", script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor }, unsignedAllowance: 1, feeBps: 300 });
    const d = decodePackDatum(String(extra.datum));
    expect(d).toMatchObject({
      channelId: extra.channelId, receiptKey: key.publicKey, buyerRefund: BUYER, seller: SELLER, feeAddress: FEE,
      pricePerCall: 20_000n, maxCalls: 100n, feeBps: 300n, closer: "c1".repeat(28), contestPeriod: 180_000n, stage: { kind: "open" },
    });
    expect(unpaid.body).toMatchObject({ mode: "escrow", escrowAddress: PACK_ESCROW.address, channelId: extra.channelId });
  });

  it("the same buyer gets a byte-identical datum; another receipt key gets another channel", async () => {
    const a = await offer();
    const b = await offer();
    expect((b.accepted.extra as { datum: string }).datum).toBe((a.accepted.extra as { datum: string }).datum);
    const other = await offer(newReceiptKey().publicKey);
    expect((other.accepted.extra as { channelId: string }).channelId).not.toBe((a.accepted.extra as { channelId: string }).channelId);
  });

  it("400 with no payment offer when the receipt key or refund address is missing or bad", async () => {
    const r1 = await request(h.app).post(packPath()).set("x-hirakumi-refund-address", BUYER);
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("receipt_key_required");
    expect(r1.headers["payment-required"]).toBeUndefined();
    const r2 = await asBuyer(request(h.app).post(packPath()), key.publicKey, "addr_test1wpw9chzut3w9chzut3w9chzut3w9chzut3w9chzut3w9chqzhh58g");
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe("bad_refund_address");
  });
});

describe("escrow pack purchase and lock verification", () => {
  beforeEach(async () => { await setup(); });

  it("paid → 200 with the channel; the verified lock activates the token", async () => {
    const { res, channelId, txHash } = await buy();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "escrow", channelId, escrowAddress: PACK_ESCROW.address, credits: 100 });
    const ch = await getChannel(h.sql, channelId);
    expect(ch).toMatchObject({ status: "locked", lock_tx_hash: txHash, lock_output_index: 1, utxo_output_index: 1 });
    expect((await call(res.body.token)).status).toBe(200);
  });

  it("a lock holding any other asset is refused and the token never works", async () => {
    const { res, channelId } = await buy("extra_assets");
    expect(res.status).toBe(200);
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "refused", refused_reason: "extra_assets" });
    const r = await call(res.body.token);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("token_pending");
  });

  it("a lock not yet on-chain is verified later by the watcher", async () => {
    const { res, channelId, txHash } = await buy("none");
    expect((await getChannel(h.sql, channelId))!.status).toBe("pending");
    const ch = await getChannel(h.sql, channelId);
    chain.putLock(txHash, ch!.datum_cbor);
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    expect(await watcher.tick()).toEqual([{ channelId, action: "verified" }]);
    expect((await call(res.body.token)).status).toBe(200);
  });
});

describe("IOU gate", () => {
  it("allowance 1: pass → Sign-Next 1; no IOU → 402 iou_required; IOU 1 → 200 Sign-Next 2", async () => {
    await setup();
    const { res, channelId } = await buy();
    const first = await call(res.body.token);
    expect(first.status).toBe(200);
    expect(first.headers["x-hirakumi-sign-next"]).toBe("1");
    const blocked = await call(res.body.token);
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ error: "iou_required", signNext: 1, channelId });
    const second = await call(res.body.token, iou(channelId, 1));
    expect(second.status).toBe(200);
    expect(second.headers["x-hirakumi-sign-next"]).toBe("2");
    expect((await getChannel(h.sql, channelId))).toMatchObject({ passes_served: 2, iou_accepted: 1 });
  });

  it("a failed call needs no IOU and doesn't count", async () => {
    await setup();
    const { res, channelId } = await buy();
    h.stub.setMode("empty");
    expect((await call(res.body.token)).status).toBe(422);
    h.stub.setMode("ok");
    expect((await call(res.body.token)).status).toBe(200);
    expect((await getChannel(h.sql, channelId))!.passes_served).toBe(1);
  });

  it("a forged IOU → 401 bad_iou; an IOU ahead of passes → 401 iou_ahead", async () => {
    await setup();
    const { res, channelId } = await buy();
    await call(res.body.token);
    const forged = `1.${signReceipt(newReceiptKey().secretKey, channelId, 1)}`;
    expect((await call(res.body.token, forged)).body.error).toBe("bad_iou");
    expect((await call(res.body.token, forged)).status).toBe(401);
    const ahead = await call(res.body.token, iou(channelId, 5));
    expect(ahead.status).toBe(401);
    expect(ahead.body.error).toBe("iou_ahead");
  });

  it("two concurrent calls with allowance 1: exactly one reaches upstream", async () => {
    await setup();
    const { res } = await buy();
    h.stub.setMode("slow");
    const [a, b] = await Promise.all([call(res.body.token), call(res.body.token)]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(h.stub.hits()).toBe(1);
  });

  it("an expired lease frees the allowance; a live one holds it", async () => {
    await setup();
    const { res, channelId } = await buy();
    await h.sql`insert into channel_leases (call_id, channel_id, expires_at) values ('call_dead', ${channelId}, now() - interval '1 second')`;
    expect((await call(res.body.token)).status).toBe(200);
    // Now a pass is unsigned; sign it, then a stuck call's live lease takes the only slot.
    await h.sql`insert into channel_leases (call_id, channel_id, expires_at) values ('call_live', ${channelId}, now() + interval '30 seconds')`;
    const r = await call(res.body.token, iou(channelId, 1));
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("iou_required");
  });

  it("allowance 3 is the channel's own: three unsigned passes, the fourth needs an IOU", async () => {
    await setup({ allowance: 3 });
    const { res } = await buy();
    await h.sql`update packs set unsigned_allowance = 1 where id = ${h.seeded.packId}`;
    for (let i = 0; i < 3; i++) expect((await call(res.body.token)).status).toBe(200);
    expect((await call(res.body.token)).body).toMatchObject({ error: "iou_required", signNext: 3 });
  });
});

describe("channel routes and the ChannelWatcher", () => {
  it("public status shows the latest IOU so anyone can verify it", async () => {
    await setup();
    const { res, channelId } = await buy();
    await call(res.body.token);
    await call(res.body.token, iou(channelId, 1));
    const v = await request(h.app).get(`/a/${h.seeded.apiId}/channels/${channelId}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: "locked", passesServed: 2, iou: { accepted: 1, receiptKey: key.publicKey } });
    expect(v.body.iou.signature).toBe(iou(channelId, 1).split(".")[1]);
  });

  it("buyer close → watcher Closes with the latest IOU → Settles after the contest period", async () => {
    await setup();
    const { res, channelId } = await buy();
    await call(res.body.token);
    await call(res.body.token, iou(channelId, 1));
    const other = await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`).set("authorization", "Bearer hk_" + "x".repeat(43));
    expect(other.status).toBe(403);
    const close = await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`)
      .set("authorization", `Bearer ${res.body.token}`).set("x-hirakumi-iou", iou(channelId, 2));
    expect(close.status).toBe(202);
    expect(close.body.status).toBe("close_requested");
    expect((await call(res.body.token, iou(channelId, 2))).status).toBe(409);

    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    const e1 = await watcher.tick();
    expect(e1).toMatchObject([{ channelId, action: "close" }]);
    expect(chain.actions[0]).toMatchObject({ kind: "close", accepted: 2 });
    await watcher.tick();
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "closing", onchain_accepted: 2, close_tx_hash: chain.actions[0]!.tx });

    chain.now += ESCROW.contestPeriodMs + 5_000;
    await h.sql`update pack_channels set last_action_at = null`;
    expect(await watcher.tick()).toMatchObject([{ channelId, action: "settle" }]);
    await watcher.tick();
    expect(await getChannel(h.sql, channelId)).toMatchObject({
      status: "settled", settle_tx_hash: chain.actions[1]!.tx, seller_paid_micros: "38800", fee_paid_micros: "1200", buyer_refund_micros: "1960000",
    });
  });

  it("the watcher Raises a stale Close (buyer closed with 0) before contest_end", async () => {
    await setup();
    const { res, channelId } = await buy();
    await call(res.body.token);
    await call(res.body.token, iou(channelId, 1));
    await call(res.body.token, iou(channelId, 2));
    await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`)
      .set("authorization", `Bearer ${res.body.token}`).set("x-hirakumi-iou", iou(channelId, 3)).expect(202);
    const ch = (await getChannel(h.sql, channelId))!;
    expect(ch.iou_accepted).toBe(3);
    // The buyer races us with Close{0}.
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0);
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    const events = await watcher.tick();
    expect(events).toMatchObject([{ channelId, action: "raise" }]);
    expect(chain.actions).toMatchObject([{ kind: "raise", accepted: 3 }]);
    await watcher.tick();
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "closing", onchain_accepted: 3 });
    expect((await getChannel(h.sql, channelId))!.raise_tx_hashes).toEqual([chain.actions[0]!.tx]);
  });

  it("no Raise inside the last minute of the contest (it could land too late); Settle once it's over", async () => {
    await setup();
    const { res, channelId } = await buy();
    await call(res.body.token);
    await call(res.body.token, iou(channelId, 1));
    await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`).set("authorization", `Bearer ${res.body.token}`).expect(202);
    const ch = (await getChannel(h.sql, channelId))!;
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0);
    chain.now += ESCROW.contestPeriodMs - 30_000;
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    expect(await watcher.tick()).toEqual([]);
    chain.now += 40_000;
    expect(await watcher.tick()).toMatchObject([{ action: "settle" }]);
  });

  it("without an operator key the watcher only observes", async () => {
    await setup({ operator: false });
    const { res, channelId } = await buy();
    await call(res.body.token);
    await call(res.body.token, iou(channelId, 1));
    const ch = (await getChannel(h.sql, channelId))!;
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0);
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    expect(await watcher.tick()).toEqual([]);
    expect(await getChannel(h.sql, channelId)).toMatchObject({ status: "closing", onchain_accepted: 0 });
  });

  it("closes automatically once every call is served", async () => {
    await setup();
    const { res, channelId } = await buy();
    await h.sql`update pack_channels set passes_served = max_calls, iou_accepted = 0 where channel_id = ${channelId}`;
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    expect(await watcher.tick()).toMatchObject([{ channelId, action: "close" }]);
    void res;
  });

  it("/receipts includes the channel", async () => {
    await setup();
    const { res, channelId } = await buy();
    const r = await request(h.app).get(`/a/${h.seeded.apiId}/receipts`).set("authorization", `Bearer ${res.body.token}`);
    expect(r.body.channel).toMatchObject({ channelId, status: "locked" });
  });
});
