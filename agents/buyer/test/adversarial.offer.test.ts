// Malicious gateway, 402 side: every test asserts the SAFE behaviour, so a failure is a vulnerability.
import { describe, expect, it } from "vitest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { ruleHash } from "@hirakumi/core";
import { PACK_ESCROW, encodePackDatum, newReceiptKey, parseAddress } from "@hirakumi/escrow";
import { buildAddress } from "../../../packages/escrow/src/address.js";
import { EscrowOfferError, checkEscrowOffer } from "../src/escrowPack.js";
import { runEscrowPack } from "../src/escrowPackFlow.js";
import { BUYER, CHANNEL, FEE, LOOSE, SELLER, STRICT, datum, flowOpts, hexOfRule, lim, maliciousEscrowGateway, offer, tmpStore } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

const MASUMI_TUSDM = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
const k = newReceiptKey().publicKey;
const scriptHash = PACK_ESCROW.scriptHash;
const ATTACKER_SCRIPT = buildAddress(0, { kind: "script", hash: "de".repeat(28) });
const ESCROW_WITH_ATTACKER_STAKE = buildAddress(0, { kind: "script", hash: scriptHash }, { kind: "key", hash: "ad".repeat(28) });
const ESCROW_WITH_SCRIPT_STAKE = buildAddress(0, { kind: "script", hash: scriptHash }, { kind: "script", hash: "ad".repeat(28) });
const ESCROW_MAINNET = buildAddress(1, { kind: "script", hash: scriptHash });
const BUYER_PAY_ATTACKER_STAKE = buildAddress(0, parseAddress("b", BUYER).payment, { kind: "key", hash: "ad".repeat(28) });
const BUYER_ENTERPRISE = buildAddress(0, parseAddress("b", BUYER).payment);

/** The datum CBOR with one extra trailing field inside the outer Constr (indefinite list: insert before the final 0xff). */
function withExtraField(cbor: string): string {
  expect(cbor.startsWith("d8799f") && cbor.endsWith("ff")).toBe(true);
  return `${cbor.slice(0, -2)}00ff`;
}

describe("adversarial 402 offers: checkEscrowOffer must refuse", () => {
  it("control: the honest offer is accepted", () => {
    expect(checkEscrowOffer(offer(k), lim(k)).channelId).toBe(CHANNEL);
  });

  it.each([
    // where the money goes
    ["payTo = seller wallet", offer(k, {}, { payTo: SELLER })],
    ["payTo = attacker script", offer(k, {}, { payTo: ATTACKER_SCRIPT })],
    ["payTo = escrow script with attacker key stake part", offer(k, {}, { payTo: ESCROW_WITH_ATTACKER_STAKE })],
    ["payTo = escrow script with attacker script stake part", offer(k, {}, { payTo: ESCROW_WITH_SCRIPT_STAKE })],
    ["payTo = escrow script on mainnet", offer(k, {}, { payTo: ESCROW_MAINNET })],
    ["payTo = escrow address upper-cased", offer(k, {}, { payTo: PACK_ESCROW.address.toUpperCase() })],
    ["assetTransferMethod default", offer(k, {}, {}, { assetTransferMethod: "default" })],
    ["assetTransferMethod masumi", offer(k, {}, {}, { assetTransferMethod: "masumi" })],
    ["assetTransferMethod missing", offer(k, {}, {}, { assetTransferMethod: undefined })],
    ["extra.script is another validator", offer(k, {}, {}, { script: { type: "plutusV3", code: `${PACK_ESCROW.scriptCbor}00` } })],
    ["extra.script declared plutusV2", offer(k, {}, {}, { script: { type: "plutusV2", code: PACK_ESCROW.scriptCbor } })],
    ["no extra at all", { ...offer(k), extra: undefined }],
    // network / scheme
    ["mainnet network", offer(k, {}, { network: "cardano:mainnet" })],
    ["another scheme", offer(k, {}, { scheme: "upto" })],
    // asset
    ["amount in Masumi tUSDM", offer(k, {}, { asset: MASUMI_TUSDM })],
    ["amount in lovelace", offer(k, {}, { asset: "lovelace" })],
    ["datum asset is Masumi tUSDM while paying x402 tUSDM", offer(k, { policyId: MASUMI_TUSDM.slice(0, 56), assetName: MASUMI_TUSDM.slice(56) })],
    // who gets refunded / who signs IOUs
    ["refund to the seller", offer(k, { buyerRefund: SELLER })],
    ["refund to our payment key with the attacker's stake key", offer(k, { buyerRefund: BUYER_PAY_ATTACKER_STAKE })],
    ["refund to our payment key, enterprise (stake dropped)", offer(k, { buyerRefund: BUYER_ENTERPRISE })],
    ["refund to the escrow script itself", offer(k, { buyerRefund: PACK_ESCROW.address })],
    ["receipt key belongs to the attacker", offer(newReceiptKey().publicKey)],
    ["receipt key upper-case variant of another key", offer(newReceiptKey().publicKey.toUpperCase())],
    // fee / timing / budgets
    ["fee_bps 10000", offer(k, { feeBps: 10_000n })],
    ["fee_bps 1001", offer(k, { feeBps: 1001n })],
    ["fee_bps negative", offer(k, { feeBps: -1n })],
    ["contest_period 0", offer(k, { contestPeriod: 0n })],
    ["contest_period negative", offer(k, { contestPeriod: -180_000n })],
    ["contest_period 30 days + 1 ms", offer(k, { contestPeriod: 30n * 86_400_000n + 1n })],
    ["close_fee_budget 100 ADA", offer(k, { closeFeeBudget: 100_000_000n })],
    ["close_fee_budget 0 (Settle can never pay its fee: stuck)", offer(k, { closeFeeBudget: 0n })],
    ["close_fee_budget negative", offer(k, { closeFeeBudget: -1n })],
    // price arithmetic
    ["price × calls < amount", offer(k, { pricePerCall: 10_000n })],
    ["price × calls > amount", offer(k, { pricePerCall: 30_000n })],
    ["negative price and negative calls (product = amount)", offer(k, { pricePerCall: -20_000n, maxCalls: -100n })],
    ["zero calls", offer(k, { pricePerCall: 0n, maxCalls: 0n }, { amount: "0" })],
    ["amount above the cap", offer(k, { pricePerCall: 60_000n }, { amount: "6000000" })],
    ["amount not an integer", offer(k, {}, { amount: "2000000.0" })],
    ["amount with a sign", offer(k, {}, { amount: "+2000000" })],
    ["amount hex", offer(k, {}, { amount: "0x1e8480" })],
    // datum shape
    ["datum that doesn't decode", offer(k, {}, {}, { datum: "deadbeef" })],
    ["datum that isn't hex", offer(k, {}, {}, { datum: "zz" })],
    ["no datum", offer(k, {}, {}, { datum: undefined })],
    ["datum with a 16th field", offer(k, {}, {}, { datum: withExtraField(encodePackDatum(datum(k))) })],
    ["datum already Closing (accepted = all calls)", offer(k, { stage: { kind: "closing", accepted: 100n, contestEnd: 1n } })],
    ["datum already Closing (accepted = 0)", offer(k, { stage: { kind: "closing", accepted: 0n, contestEnd: 9_999_999_999_999n } })],
    ["seller is the escrow script (payout locked forever)", offer(k, { seller: PACK_ESCROW.address })],
    ["fee address is a script", offer(k, { feeAddress: ATTACKER_SCRIPT })],
    ["closer is not 28 bytes", offer(k, { closer: "c1".repeat(27) })],
    ["channel id in extra disagrees with the datum", offer(k, {}, {}, { channelId: "22".repeat(32) })],
  ])("refuses: %s", (_name, req) => {
    expect(() => checkEscrowOffer(req, lim(k))).toThrow(EscrowOfferError);
  });
});

describe("adversarial 402 offers: the lock must match the pack the buyer chose (runEscrowPack)", () => {
  const deps = (g: ReturnType<typeof maliciousEscrowGateway>) => ({
    fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store: tmpStore(), refundAddress: BUYER,
    log: () => {}, sleep: async () => {}, now: () => new Date("2026-10-06T00:00:00Z"),
  });

  it("control: an honest lock for the advertised pack is paid", async () => {
    const g = maliciousEscrowGateway({ lock: (key) => offer(key), calls: [() => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" })] });
    const s = await runEscrowPack(deps(g), flowOpts());
    expect(g.state.paid).toBe(1);
    expect(s.signed).toBe(1);
  });

  it("bait and switch on CALLS: advertises 100 calls for 2 tUSDM, the datum locks 10 calls × 0.2 tUSDM", async () => {
    // Same amount, same cap, everything else honest: the per-call price is 10× what the buyer chose.
    const g = maliciousEscrowGateway({ lock: (key) => offer(key, { pricePerCall: 200_000n, maxCalls: 10n }) });
    await expect(runEscrowPack(deps(g), flowOpts(0))).rejects.toThrow(EscrowOfferError);
    expect(g.state.paid).toBe(0);
  });

  it("bait and switch on PRICE: advertises 2 tUSDM, the 402 asks 5 tUSDM (still under the 5 tUSDM cap)", async () => {
    const g = maliciousEscrowGateway({ lock: (key) => offer(key, { pricePerCall: 50_000n }, { amount: "5000000" }) });
    await expect(runEscrowPack(deps(g), flowOpts(0))).rejects.toThrow(EscrowOfferError);
    expect(g.state.paid).toBe(0);
  });

  it("the datum's ruleHash must be the promise the buyer will check (offer says LOOSE, datum says STRICT)", async () => {
    const g = maliciousEscrowGateway({
      offerRuleHash: ruleHash(LOOSE),
      lock: (key) => offer(key, { ruleHash: hexOfRule(STRICT) }),
      rules: (hash) => json(200, { ruleHash: hash, definition: hash === ruleHash(LOOSE) ? LOOSE : STRICT }),
    });
    await expect(runEscrowPack(deps(g), flowOpts(0))).rejects.toThrow(EscrowOfferError);
    expect(g.state.paid).toBe(0);
  });

  it("the channel id the gateway returns after payment must be the channel in the datum we checked", async () => {
    const g = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => ({ channelId: "99".repeat(32) }) });
    const d = deps(g);
    await runEscrowPack(d, flowOpts(0)).catch(() => {});
    // SAFE = the flow refused to adopt the substituted id (it threw or kept the datum's id).
    expect(d.store.get("api_demo", "pk_demo")?.channelId ?? CHANNEL).toBe(CHANNEL);
  });

  it("a non-canonical (definite-length) datum encoding is refused or re-encodes to the same bytes", () => {
    const canonical = encodePackDatum(datum(k));
    expect(canonical.startsWith("d8799f") && canonical.endsWith("ff")).toBe(true);
    const definite = `d8798f${canonical.slice(6, -2)}`; // same Data, outer list as a definite 15-item array
    const req = offer(k, {}, {}, { datum: definite });
    let d: ReturnType<typeof checkEscrowOffer> | null = null;
    try { d = checkEscrowOffer(req, lim(k)); } catch (e) { expect(e).toBeInstanceOf(EscrowOfferError); }
    if (d) expect(encodePackDatum(d)).toBe(definite);
  });

  it("fee address = attacker with fee 10% is accepted by policy (documents the ceiling, not a bug)", () => {
    // Not a vulnerability: 10% is the configured ceiling. The seller and fee addresses are not knowable by the buyer.
    expect(checkEscrowOffer(offer(k, { feeBps: 1000n, feeAddress: SELLER, seller: FEE }), lim(k)).feeBps).toBe(1000n);
  });

  it("a 30-day contest period is accepted by policy (documents the ceiling)", () => {
    expect(checkEscrowOffer(offer(k, { contestPeriod: 30n * 86_400_000n }), lim(k)).contestPeriod).toBe(30n * 86_400_000n);
  });

  it("the advertised asset is ignored when it isn't tUSDM: no pack is chosen", async () => {
    const g = maliciousEscrowGateway({ listing: [{ packId: "pk_demo", calls: 100, price: "2000000", asset: MASUMI_TUSDM }], lock: (key) => offer(key) });
    await expect(runEscrowPack(deps(g), flowOpts(0))).rejects.toThrow(/No payable pack/);
    expect(g.state.paid).toBe(0);
    expect(USDM_PREPROD_ASSET).not.toBe(MASUMI_TUSDM);
  });
});
