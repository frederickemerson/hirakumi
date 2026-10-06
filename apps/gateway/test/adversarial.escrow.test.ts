// Adversarial review: escrow packs (PACK_MODE=escrow), the IOU gate and the ChannelWatcher.
// Every test asserts the SAFE behaviour, so a failing test is a demonstrated vulnerability.
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { newReceiptKey, receiptMessage, signReceipt } from "@hirakumi/escrow";
import { sha256Hex } from "@hirakumi/core";
import { getChannel } from "@hirakumi/db";
import { ChannelWatcher } from "../src/channelWatcher";
import type { PackEscrowConfig } from "../src/config";
import { FakeEscrowChain } from "./fakeChain";
import { fakeTxHash, makeHarness, type Harness } from "./helpers";

// noble (what the gateway verifies IOUs with) and libsodium (what cardano-node's verify_ed25519_signature uses).
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const { ed25519 } = createRequire(resolve(repo, "packages/escrow/package.json"))("@noble/curves/ed25519") as typeof import("../../../packages/escrow/node_modules/@noble/curves/ed25519");
type Sodium = { ready: Promise<void>; crypto_sign_verify_detached(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean };
const sodium = createRequire(resolve(repo, "node_modules/.pnpm/libsodium-wrappers-sumo@0.7.10/node_modules/libsodium-wrappers-sumo/package.json"))("libsodium-wrappers-sumo") as Sodium;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
/** Cardano (libsodium) semantics: what the on-chain validator's Raise / Close would accept. */
async function cardanoAccepts(receiptKey: string, channelId: string, accepted: number, signature: string): Promise<boolean> {
  await sodium.ready;
  return sodium.crypto_sign_verify_detached(unhex(signature), receiptMessage(channelId, accepted), unhex(receiptKey));
}

const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
const SCRIPT_ADDR = "addr_test1wpw9chzut3w9chzut3w9chzut3w9chzut3w9chzut3w9chqzhh58g";
const ESCROW: PackEscrowConfig = {
  feeAddress: FEE, feeBps: 300, closerVkh: "c1".repeat(28), contestPeriodMs: 180_000, closeFeeBudgetLovelace: 700_000,
  operatorMnemonic: null, leaseSeconds: 30, raiseMarginMs: 60_000,
};

let h: Harness;
let chain: FakeEscrowChain;
let receiptKey: string;
let secretKey: string;

async function setup(o: { allowance?: number; receiptKey?: string } = {}) {
  chain = new FakeEscrowChain(true);
  h = await makeHarness({ config: { packMode: "escrow", packEscrow: ESCROW, upstreamTimeoutMs: 3_000 }, escrowChain: chain, facilitatorMethods: ["default", "script"] });
  await h.sql`update sellers set cardano_addr = ${SELLER} where id = ${h.seeded.sellerId}`;
  if (o.allowance) await h.sql`update packs set unsigned_allowance = ${o.allowance} where id = ${h.seeded.packId}`;
  const k = newReceiptKey();
  secretKey = k.secretKey;
  receiptKey = o.receiptKey ?? k.publicKey;
}
afterEach(async () => { await h?.close(); });

const packPath = () => `/a/${h.seeded.apiId}/packs/${h.seeded.packId}`;
const callPath = () => `/a/${h.seeded.apiId}/x/getPrice?symbol=ADA`;
const asBuyer = (r: request.Test, k = receiptKey, refund = BUYER) => r.set("x-hirakumi-receipt-key", k).set("x-hirakumi-refund-address", refund);

async function offer(k = receiptKey, refund = BUYER) {
  const unpaid = await asBuyer(request(h.app).post(packPath()), k, refund);
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(String(unpaid.headers["payment-required"]));
  return { required, accepted: required.accepts[0]! };
}

async function buy() {
  const { required, accepted } = await offer();
  const transaction = `lock-${randomBytes(8).toString("hex")}`;
  const txHash = fakeTxHash(transaction)!;
  chain.putLock(txHash, String((accepted.extra as { datum: string }).datum));
  const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
  const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header)).set("x-hirakumi-recovery", sha256Hex("secret"));
  expect(res.status).toBe(200);
  return { token: String(res.body.token), txHash, channelId: String((accepted.extra as { channelId: string }).channelId) };
}

const call = (token: string, iou?: string) => {
  const r = request(h.app).get(callPath()).set("authorization", `Bearer ${token}`);
  return iou ? r.set("x-hirakumi-iou", iou) : r;
};
const iou = (channelId: string, n: number) => `${n}.${signReceipt(secretKey, channelId, n)}`;

// ---------------------------------------------------------------- IOU signature semantics vs the chain

/** Identity point: a small-order "public key". With R = identity and S = 0, noble's cofactored ZIP-215 check passes any message. */
const SMALL_ORDER_KEY = "01" + "00".repeat(31);
const SMALL_ORDER_SIG = "01" + "00".repeat(63);

/** An honest key, but R gets an 8-torsion component: cofactored verify (noble) passes, cofactorless (libsodium/Cardano) fails. */
function mixedOrderSignature(sk: string, channelId: string, accepted: number): string {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = (b: Uint8Array) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(b[i]!); return n; };
  const toLe = (n: bigint) => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; };
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(unhex(sk));
  const torsion = ed25519.Point.fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"); // order 8
  const msg = receiptMessage(channelId, accepted);
  const r = le(randomBytes(64)) % L;
  const R = ed25519.Point.BASE.multiply(r).add(torsion).toBytes();
  const k = le(createHash("sha512").update(R).update(pointBytes).update(msg).digest()) % L;
  const sig = new Uint8Array(64);
  sig.set(R, 0);
  sig.set(toLe((r + k * scalar) % L), 32);
  return hex(sig);
}

describe("adversarial: IOU signatures the gateway accepts but the chain rejects", () => {
  it("small-order receipt key: forged IOUs must not unlock calls beyond the unsigned allowance", async () => {
    await setup({ receiptKey: SMALL_ORDER_KEY });
    // The gateway should refuse to sell an escrow pack to a key no on-chain IOU can ever be valid for.
    const { required } = await offer().catch(() => ({ required: null }));
    if (!required) return; // refused at quote time: SAFE
    const { token, channelId } = await buy();
    let served = 0;
    for (let n = 0; n < 6; n++) {
      const r = await call(token, n === 0 ? undefined : `${n}.${SMALL_ORDER_SIG}`);
      if (r.status === 200) served += 1;
    }
    const ch = (await getChannel(h.sql, channelId))!;
    // What the seller can actually claim on-chain with the stored IOU.
    const claimable = ch.iou_signature && (await cardanoAccepts(ch.receipt_key, channelId, ch.iou_accepted, ch.iou_signature)) ? ch.iou_accepted : 0;
    expect(served - claimable).toBeLessThanOrEqual(ch.unsigned_allowance);
  });

  it("honest-looking key + mixed-order R: IOUs the validator rejects must not unlock calls beyond the allowance", async () => {
    await setup();
    const { token, channelId } = await buy();
    expect(ed25519.verify(unhex(mixedOrderSignature(secretKey, channelId, 1)), receiptMessage(channelId, 1), unhex(receiptKey))).toBe(true);
    expect(await cardanoAccepts(receiptKey, channelId, 1, mixedOrderSignature(secretKey, channelId, 1))).toBe(false);
    let served = 0;
    for (let n = 0; n < 6; n++) {
      const r = await call(token, n === 0 ? undefined : `${n}.${mixedOrderSignature(secretKey, channelId, n)}`);
      if (r.status === 200) served += 1;
    }
    const ch = (await getChannel(h.sql, channelId))!;
    const claimable = ch.iou_signature && (await cardanoAccepts(ch.receipt_key, channelId, ch.iou_accepted, ch.iou_signature)) ? ch.iou_accepted : 0;
    expect(served - claimable).toBeLessThanOrEqual(ch.unsigned_allowance);
  });

  it("control: honest IOUs verify under Cardano semantics too", async () => {
    await setup();
    const { token, channelId } = await buy();
    for (let n = 0; n < 4; n++) expect((await call(token, n === 0 ? undefined : iou(channelId, n))).status).toBe(200);
    const ch = (await getChannel(h.sql, channelId))!;
    expect(ch.iou_accepted).toBe(3);
    expect(await cardanoAccepts(ch.receipt_key, channelId, 3, ch.iou_signature!)).toBe(true);
  });
});

// ---------------------------------------------------------------- IOU gate

describe("adversarial: IOU gate", () => {
  it("an IOU signed for another channel (same receipt key) is rejected", async () => {
    await setup();
    const a = await buy();
    const b = await buy();
    await call(a.token);
    await call(b.token);
    const r = await call(a.token, iou(b.channelId, 1));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("bad_iou");
    expect((await getChannel(h.sql, a.channelId))!.iou_accepted).toBe(0);
  });

  it("an IOU above the passes served is rejected (no pre-signing to unlock calls)", async () => {
    await setup();
    const { token, channelId } = await buy();
    const r = await call(token, iou(channelId, 50));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("iou_ahead");
    expect((await getChannel(h.sql, channelId))!.iou_accepted).toBe(0);
  });

  it("an older IOU (replayed via a call or /close) never lowers the stored one", async () => {
    await setup();
    const { token, channelId } = await buy();
    await call(token);
    await call(token, iou(channelId, 1));
    await call(token, iou(channelId, 2));
    expect((await getChannel(h.sql, channelId))!.iou_accepted).toBe(2);
    await call(token, iou(channelId, 1));
    await call(token, iou(channelId, 0));
    await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`).set("authorization", `Bearer ${token}`).set("x-hirakumi-iou", iou(channelId, 1));
    expect((await getChannel(h.sql, channelId))!).toMatchObject({ iou_accepted: 2, iou_signature: iou(channelId, 2).split(".")[1] });
  });

  it("8 concurrent calls with allowance 2 never exceed the allowance of unsigned passes", async () => {
    await setup({ allowance: 2 });
    const { token, channelId } = await buy();
    h.stub.setMode("slow");
    const rs = await Promise.all(Array.from({ length: 8 }, () => call(token)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(h.stub.hits()).toBe(2);
    const ch = (await getChannel(h.sql, channelId))!;
    expect(ch.passes_served - ch.iou_accepted).toBeLessThanOrEqual(2);
    const [{ remaining }] = await h.sql<{ remaining: number }[]>`select remaining from credit_tokens where id = ${ch.credit_token_id}`;
    expect(remaining).toBe(98);
  });

  it("no call is served once the buyer asked to close, nor after an on-chain Close", async () => {
    await setup({ allowance: 3 });
    const { token, channelId } = await buy();
    expect((await call(token)).status).toBe(200);
    await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`).set("authorization", `Bearer ${token}`).expect(202);
    expect((await call(token)).status).toBe(409);
    const ch = (await getChannel(h.sql, channelId))!;
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0);
    await h.sql`update pack_channels set last_action_at = now() where channel_id = ${channelId}`; // watcher observes only
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    expect((await getChannel(h.sql, channelId))!.status).toBe("closing");
    expect((await call(token)).status).toBe(409);
    expect(h.stub.hits()).toBe(1);
  });
});

// ---------------------------------------------------------------- quotes and buyer keys

describe("adversarial: escrow quotes", () => {
  it("paying quote A's datum while presenting buyer B's headers never settles or opens a channel", async () => {
    await setup();
    const a = await offer();
    const other = newReceiptKey().publicKey;
    await offer(other); // B's live quote exists too
    const transaction = "lock-cross";
    chain.putLock(fakeTxHash(transaction)!, String((a.accepted.extra as { datum: string }).datum));
    const header = encodePaymentSignatureHeader({ x402Version: a.required.x402Version, resource: a.required.resource, accepted: a.accepted, payload: { transaction, nonce: "n" } });
    const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header), other);
    expect(res.status).toBe(402);
    expect(h.facilitator.settleCalls).toBe(0);
    expect(await h.sql`select 1 from pack_channels`).toHaveLength(0);
  });

  it("a paid quote cannot be paid twice (second tx → 409, no settle)", async () => {
    await setup();
    const { required, accepted } = await offer();
    const pay = (transaction: string) => asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE",
      encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } })));
    chain.putLock(fakeTxHash("lock-1")!, String((accepted.extra as { datum: string }).datum));
    expect((await pay("lock-1")).status).toBe(200);
    const second = await pay("lock-2");
    expect(second.status).not.toBe(200);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(await h.sql`select 1 from pack_channels`).toHaveLength(1);
  });

  it("a script refund address or the escrow itself is refused before any offer", async () => {
    await setup();
    const { PACK_ESCROW } = await import("@hirakumi/escrow");
    for (const refund of [SCRIPT_ADDR, PACK_ESCROW.address, "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x"]) {
      const r = await asBuyer(request(h.app).post(packPath()), receiptKey, refund);
      expect(r.status).toBe(400);
      expect(r.headers["payment-required"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------- the ChannelWatcher

async function fillerChannels(like: string, n: number, status: string) {
  // n older channels (copies of a real row with fresh ids) – e.g. other buyers' packs, or an attacker's.
  await h.sql`
    insert into credit_tokens (id, api_id, pack_id, token_hash, status, remaining, payment_payload_hash)
    select 'ct_fill_' || g, api_id, pack_id, md5('t' || g) || md5('u' || g), 'active', 100, md5('p' || g) || md5('q' || g)
    from credit_tokens, generate_series(1, ${n}) g where id = (select credit_token_id from pack_channels where channel_id = ${like})`;
  await h.sql`
    insert into pack_channels (channel_id, api_id, pack_id, credit_token_id, receipt_key, refund_address, seller_address, fee_address, fee_bps,
      price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, status,
      lock_tx_hash, created_at)
    select md5('c' || g) || md5('d' || g), api_id, pack_id, 'ct_fill_' || g, receipt_key, refund_address, seller_address, fee_address, fee_bps,
      price_micros, price_per_call_micros, max_calls, unsigned_allowance, contest_period_ms, close_fee_budget_lovelace, datum_cbor, ${status},
      md5('l' || g) || md5('m' || g), now() - interval '1 day'
    from pack_channels, generate_series(1, ${n}) g where channel_id = ${like}`;
}

describe("adversarial: ChannelWatcher", () => {
  const staleCloseRaised = async (fillers: number) => {
    await setup();
    const { token, channelId } = await buy();
    await call(token);
    await call(token, iou(channelId, 1));
    await call(token, iou(channelId, 2));
    await request(h.app).post(`/a/${h.seeded.apiId}/channels/${channelId}/close`).set("authorization", `Bearer ${token}`).set("x-hirakumi-iou", iou(channelId, 3));
    await fillerChannels(channelId, fillers, "locked");
    const ch = (await getChannel(h.sql, channelId))!;
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0); // the buyer closes with 0 on-chain
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    await watcher.tick();
    expect(chain.actions.filter((a) => a.kind === "raise")).toMatchObject([{ accepted: 3 }]);
  };
  it("control: with 199 older live channels a newer channel's stale buyer Close (0) is Raised", () => staleCloseRaised(199), 60_000);
  it("with 200 older live channels, a newer channel's stale buyer Close (0) is still Raised", () => staleCloseRaised(200), 60_000);

  const lateLockVerified = async (fillers: number) => {
    await setup();
    const first = await buy();
    await fillerChannels(first.channelId, fillers, "pending");
    // A new buyer whose lock is not yet indexed at settle time (Blockfrost lag): only the watcher can verify it.
    const k = newReceiptKey();
    const { required, accepted } = await offer(k.publicKey);
    const transaction = "lock-late";
    const header = encodePaymentSignatureHeader({ x402Version: required.x402Version, resource: required.resource, accepted, payload: { transaction, nonce: "n" } });
    const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header), k.publicKey);
    expect(res.status).toBe(200);
    chain.putLock(fakeTxHash(transaction)!, String((accepted.extra as { datum: string }).datum));
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    expect((await getChannel(h.sql, String(res.body.channelId)))!.status).toBe("locked");
    expect((await call(String(res.body.token))).status).toBe(200);
  };
  it("control: with 199 older pending channels a newer paid lock is verified by the watcher", () => lateLockVerified(199), 60_000);
  it("with 200 older pending channels (dead locks), a newer paid lock is still verified", () => lateLockVerified(200), 60_000);

  it("a verified lock that is rolled back (lock tx gone from the chain) stops serving calls", async () => {
    await setup({ allowance: 100 });
    const { token, txHash } = await buy();
    expect((await call(token)).status).toBe(200);
    chain.txs.delete(txHash); // rollback: the lock tx was dropped and its inputs double-spent
    await new ChannelWatcher({ sql: h.sql, chain, config: ESCROW }).tick();
    expect((await call(token)).status).not.toBe(200);
  });

  it("a buyer Close that is rolled back does not leave the channel stuck in 'closing'", async () => {
    await setup();
    const { token, channelId, txHash } = await buy();
    const ch = (await getChannel(h.sql, channelId))!;
    const closeTx = chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 0);
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    await watcher.tick();
    expect((await getChannel(h.sql, channelId))!.status).toBe("closing");
    // Rollback: the Close vanishes, the lock UTxO is unspent and Open again.
    chain.txs.delete(closeTx);
    chain.output({ txHash, index: 1 }).consumedBy = null;
    await watcher.tick();
    const after = (await getChannel(h.sql, channelId))!;
    // SAFE = the gateway follows the chain: Open again, so the buyer's paid calls work.
    expect(after.status).toBe("locked");
    expect((await call(token)).status).toBe(200);
  });

  it("the watcher never Settles before contest_end and never Closes an unrequested open channel", async () => {
    await setup();
    const { token, channelId } = await buy();
    await call(token);
    await call(token, iou(channelId, 1));
    const watcher = new ChannelWatcher({ sql: h.sql, chain, config: ESCROW });
    await watcher.tick();
    expect(chain.actions).toEqual([]);
    const ch = (await getChannel(h.sql, channelId))!;
    chain.closeAs({ txHash: ch.utxo_tx_hash!, index: ch.utxo_output_index! }, 1);
    await watcher.tick();
    await h.sql`update pack_channels set last_action_at = null`;
    chain.now += ESCROW.contestPeriodMs - 1;
    await watcher.tick();
    expect(chain.actions.filter((a) => a.kind === "settle")).toEqual([]);
  });

  it("a lock whose datum names another channel id is refused (no token)", async () => {
    await setup();
    const a = await offer();
    const b = await offer(newReceiptKey().publicKey);
    const transaction = "lock-wrong-datum";
    chain.putLock(fakeTxHash(transaction)!, String((b.accepted.extra as { datum: string }).datum)); // locks B's datum, pays as A
    const header = encodePaymentSignatureHeader({ x402Version: a.required.x402Version, resource: a.required.resource, accepted: a.accepted, payload: { transaction, nonce: "n" } });
    const res = await asBuyer(request(h.app).post(packPath()).set("PAYMENT-SIGNATURE", header));
    expect(res.status).toBe(200);
    expect((await getChannel(h.sql, String(res.body.channelId)))!.status).toBe("refused");
    expect((await call(String(res.body.token))).status).toBe(401);
  });
});
