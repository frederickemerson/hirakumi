// Independent verifier: attacks on the fixes for G2 (expiry), G3 (pending token), G4 (rollbacks) and the
// close-auth route. Every test asserts the SAFE behaviour, so a failing test is a demonstrated problem.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { newReceiptKey, signCloseRequest, signReceipt } from "@hirakumi/escrow";
import { sha256Hex } from "@hirakumi/core";
import { getChannel } from "@hirakumi/db";
import { ChannelWatcher } from "../src/channelWatcher";
import type { PackEscrowConfig } from "../src/config";
import { FakeEscrowChain } from "./fakeChain";
import { fakeTxHash, makeHarness, type Harness } from "./helpers";

const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
const ESCROW: PackEscrowConfig = {
  feeAddress: FEE, feeBps: 300, closerVkh: "c1".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000,
  operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};

let h: Harness;
let chain: FakeEscrowChain;
let keys: { secretKey: string; publicKey: string };

async function setup(o: { escrow?: boolean } = {}) {
  chain = new FakeEscrowChain(true);
  h = o.escrow === false
    ? await makeHarness()
    : await makeHarness({ config: { packMode: "escrow", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  keys = newReceiptKey();
}
afterEach(async () => { await h?.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
const callPath = () => `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`;
const closePath = (channelId: string, apiId = h.seeded.apiId) => `/a/${apiId}/channels/${channelId}/close`;
const asBuyer = (r: request.Test, k = keys.publicKey) => r.set("x-hirakumi-receipt-key", k).set("x-hirakumi-refund-address", BUYER);
const call = (token: string, iou?: string) => {
  const r = request(h.app).get(callPath()).set("authorization", `Bearer ${token}`);
  return iou ? r.set("x-hirakumi-iou", iou) : r;
};

async function buy(k = keys, o: { land?: boolean } = {}) {
  const unpaid = await asBuyer(request(h.app).post(packPath()), k.publicKey);
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  const accepted = required.accepts[0]!;
  const transaction = `lock-${randomBytes(8).toString("hex")}`;
  const txHash = fakeTxHash(transaction)!;
  if (o.land !== false) chain.putLock(txHash, String((accepted.extra as { datum: string }).datum));
  const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
  const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header), k.publicKey).set("x-hirakumi-recovery", sha256Hex("s"));
  expect(res.status).toBe(200);
  return { token: String(res.body.token), txHash, channelId: String((accepted.extra as { channelId: string }).channelId), datum: String((accepted.extra as { datum: string }).datum) };
}

// ---------------------------------------------------------------- close-auth (HKC1)

describe("verify: close-auth route", () => {
  it("someone else's key, an HKR1 IOU, another channel's close-auth, a bad hex, or the wrong API never close a channel", async () => {
    await setup();
    const a = await buy();
    const otherKeys = newReceiptKey();
    const b = await buy(otherKeys);
    const attempts: [string, string, string][] = [
      ["attacker's own key over the victim channel", a.channelId, signCloseRequest(otherKeys.secretKey, a.channelId)],
      ["the victim's HKR1 IOU used as close-auth", a.channelId, signReceipt(keys.secretKey, a.channelId, 0)],
      ["close-auth for channel B replayed on A", a.channelId, signCloseRequest(otherKeys.secretKey, b.channelId)],
      ["truncated", a.channelId, signCloseRequest(keys.secretKey, a.channelId).slice(0, 126)],
      ["non-hex", a.channelId, "zz".repeat(64)],
    ];
    for (const [name, ch, auth] of attempts) {
      const r = await request(h.app).post(closePath(ch)).set("x-hirakumi-close-auth", auth);
      expect(r.status, name).not.toBe(202);
    }
    const wrongApi = await request(h.app).post(closePath(a.channelId, "api_nope")).set("x-hirakumi-close-auth", signCloseRequest(keys.secretKey, a.channelId));
    expect(wrongApi.status).toBe(404);
    expect((await getChannel(h.sql, a.channelId))!.status).toBe("locked");
    expect((await getChannel(h.sql, b.channelId))!.status).toBe("locked");
    // Control: the channel's own key closes it.
    const ok = await request(h.app).post(closePath(a.channelId)).set("x-hirakumi-close-auth", signCloseRequest(keys.secretKey, a.channelId).toUpperCase());
    expect(ok.status).toBe(202);
    expect((await getChannel(h.sql, a.channelId))!.status).toBe("close_requested");
  });

  it("close-auth can't record a forged or ahead-of-service IOU, nor re-open a settled channel", async () => {
    await setup();
    const a = await buy();
    expect((await call(a.token)).status).toBe(200);
    const auth = signCloseRequest(keys.secretKey, a.channelId);
    const ahead = await request(h.app).post(closePath(a.channelId)).set("x-hirakumi-close-auth", auth).set("x-hirakumi-iou", `5.${signReceipt(keys.secretKey, a.channelId, 5)}`);
    expect(ahead.status).toBe(401);
    await h.sql`update pack_channels set status = 'settled' where channel_id = ${a.channelId}`;
    const r = await request(h.app).post(closePath(a.channelId)).set("x-hirakumi-close-auth", auth);
    expect(r.status === 202 ? r.body.status : "refused").not.toBe("close_requested");
    expect((await getChannel(h.sql, a.channelId))!.status).toBe("settled");
  });
});

// ---------------------------------------------------------------- G4: rollbacks

describe("verify: rollbacks (G4)", () => {
  it("after the gateway's own Close (asked for by the buyer) is rolled back, the gateway closes again", async () => {
    await setup();
    const a = await buy();
    expect((await call(a.token)).status).toBe(200);
    // The buyer is done and asks to close; the watcher submits Close and then sees it on-chain.
    expect((await request(h.app).post(closePath(a.channelId)).set("authorization", `Bearer ${a.token}`)).status).toBe(202);
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    await watcher.tick();
    expect(chain.actions.map((x) => x.kind)).toEqual(["close"]);
    await watcher.tick();
    expect((await getChannel(h.sql, a.channelId))!.status).toBe("closing");
    // Rollback of that Close: the lock is unspent and Open again.
    chain.txs.delete(chain.actions[0]!.tx);
    chain.output({ txHash: a.txHash, index: 1 }).consumedBy = null;
    await watcher.tick();
    await h.sql`update pack_channels set last_action_at = null`;
    await watcher.tick();
    const after = (await getChannel(h.sql, a.channelId))!;
    // SAFE: the buyer's close request survives the rollback (re-closed, or still queued) -- not silently
    // back to 'locked', where the watcher never closes and the buyer's unused funds stay locked.
    const reclosed = chain.actions.filter((x) => x.kind === "close").length === 2;
    expect(reclosed || after.status === "close_requested", `status after rollback: ${after.status}`).toBe(true);
  });
});

// ---------------------------------------------------------------- G2: expiring unseen locks

describe("verify: expireUnseenLocks (G2)", () => {
  it("a lock that IS on-chain is not refused just because the chain API errored when the hour ran out", async () => {
    await setup();
    // Settle-time verification could not see the lock (indexer lag), so the channel is pending.
    const a = await buy(keys, { land: false });
    expect((await getChannel(h.sql, a.channelId))!.status).toBe("pending");
    chain.putLock(a.txHash, a.datum); // it did land
    await h.sql`update pack_channels set created_at = now() - interval '61 minutes' where channel_id = ${a.channelId}`;
    // Blockfrost is down / rate-limiting (5xx/429 throw; only a 404 means "unknown tx").
    const real = chain.txOutputs.bind(chain);
    chain.txOutputs = async () => { throw new Error("Blockfrost 503"); };
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    chain.txOutputs = real;
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    const ch = (await getChannel(h.sql, a.channelId))!;
    // SAFE: the buyer's locked pack eventually works (or at least is not permanently refused while funded on-chain).
    expect(ch.status, `refused_reason=${ch.refused_reason}`).not.toBe("refused");
  });
});

// ---------------------------------------------------------------- G3: pending token in the settlement-failed body

describe("verify: G3 pending token", () => {
  it("a concurrent replay of a plain buyer's PAYMENT-SIGNATURE never receives the buyer's token", async () => {
    await setup({ escrow: false });
    h.facilitator.settleMode = "fail";
    const origSettle = h.facilitator.settle.bind(h.facilitator);
    h.facilitator.settle = async (p, r) => { await new Promise((ok) => setTimeout(ok, 300)); return origSettle(p, r); };
    const unpaid = await request(h.app).post(packPath());
    const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
    const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted: required.accepts[0]!, payload: { transaction: "tx-g3", nonce: "1" } });
    const [buyer, replay] = await Promise.all([
      request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header),
      new Promise((ok) => setTimeout(ok, 50)).then(() => request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header)),
    ]);
    const tokens = [buyer.body.token, replay.body.token].filter((t) => typeof t === "string");
    expect(tokens.length).toBeLessThanOrEqual(1);
    expect(replay.body.token).toBeUndefined();
    expect(typeof buyer.body.token).toBe("string");
  });
});
