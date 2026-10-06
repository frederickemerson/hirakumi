// Malicious gateway vs the real createPackPayer (x402 wrapFetchWithPayment + spend controls + the escrow hook).
// The Cardano scheme is replaced by a recorder: nothing is ever built, signed or submitted, and global fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { newReceiptKey } from "@hirakumi/escrow";
import { checkEscrowOffer } from "../src/escrowPack.js";
import { BUYER, lim, offer } from "./adversarial.helpers.js";

const signed: Array<Record<string, unknown>> = [];
vi.mock("@x402/cardano/exact/client", async () => {
  const { findDefaultAsset } = await vi.importActual<typeof import("@x402/cardano")>("@x402/cardano");
  class ExactCardanoScheme {
    scheme = "exact";
    findDefaultAsset = findDefaultAsset;
    constructor(_signer: unknown) {}
    async createPaymentPayload(v: number, req: Record<string, unknown>) {
      signed.push(req); // reaching here = the buyer agreed to sign this payment
      return { x402Version: v, payload: { transaction: "AA==", nonce: "00#0" } };
    }
  }
  return { ExactCardanoScheme };
});
vi.mock("@x402/cardano", async () => {
  const real = await vi.importActual<typeof import("@x402/cardano")>("@x402/cardano");
  return { ...real, toClientCardanoSigner: () => ({ getAddress: () => BUYER }) };
});

const MASUMI_TUSDM = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
const BUY = "https://gw.test/a/api_demo/packs/pk_demo";

/** A gateway whose buy endpoint answers 402 with `accepts`, then 200 for any paid retry. */
function stubGateway(accepts: Array<Record<string, unknown>>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    urls.push(req.url);
    if (!req.url.startsWith("https://gw.test/")) throw new Error(`unexpected network access ${req.url}`);
    if (!req.headers.get("payment-signature")) {
      const pr = { x402Version: 2, resource: { url: BUY }, accepts: accepts.map((a) => ({ maxTimeoutSeconds: 600, ...a })) };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never) } });
    }
    return new Response(JSON.stringify({ token: "hk_tok", credits: 100, apiId: "api_demo", channelId: "11".repeat(32) }), { status: 200 });
  });
  return urls;
}
async function payer() {
  const { createPackPayer } = await import("../src/payClient.js");
  return createPackPayer({ mnemonic: "unused", blockfrostProjectId: "unused", blockfrostBaseUrl: "https://blockfrost.invalid", maxPackMicros: 5_000_000n });
}
const direct = (amount: string, asset = USDM_PREPROD_ASSET, extra: Record<string, unknown> = {}) =>
  ({ scheme: "exact", network: "cardano:preprod", asset, amount, payTo: "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y", extra });

beforeEach(() => { signed.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("direct packs: spend controls", () => {
  it("control: a 2 tUSDM pack under a 5 tUSDM cap is paid", async () => {
    stubGateway([direct("2000000")]);
    await (await payer()).buyPack(BUY, { amount: 2_000_000n });
    expect(signed).toHaveLength(1);
  });
  it("refuses 6 tUSDM when the cap is 5", async () => {
    stubGateway([direct("6000000")]);
    await expect((await payer()).buyPack(BUY, { amount: 2_000_000n })).rejects.toThrow();
    expect(signed).toHaveLength(0);
  });
  it("refuses Masumi tUSDM (different policy)", async () => {
    stubGateway([direct("2000000", MASUMI_TUSDM)]);
    await expect((await payer()).buyPack(BUY, { amount: 2_000_000n })).rejects.toThrow();
    expect(signed).toHaveLength(0);
  });
  it("refuses lovelace", async () => {
    stubGateway([direct("2000000", "lovelace")]);
    await expect((await payer()).buyPack(BUY, { amount: 2_000_000n })).rejects.toThrow();
    expect(signed).toHaveLength(0);
  });
  it("with several accepts, never picks one above the cap / wrong asset", async () => {
    stubGateway([direct("9000000"), direct("2000000", MASUMI_TUSDM), direct("2000000")]);
    await (await payer()).buyPack(BUY, { amount: 2_000_000n });
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({ amount: "2000000", asset: USDM_PREPROD_ASSET });
  });
  it("bait and switch: the listing said 1 tUSDM (pack chosen for that), the buy 402 asks 5 tUSDM — must not pay more than the chosen pack", async () => {
    // buyPack(buyUrl) is not told the price of the pack it chose, so the only limit is the global 5 tUSDM cap.
    stubGateway([direct("5000000")]);
    const p = await payer();
    await p.buyPack(BUY, { amount: 1_000_000n }).catch(() => {});
    expect(signed.filter((r) => BigInt(r.amount as string) > 1_000_000n)).toHaveLength(0);
  });
});

describe("escrow packs: the datum check runs before anything is signed", () => {
  const k = newReceiptKey().publicKey;
  const check = (req: Parameters<typeof checkEscrowOffer>[0]) => { checkEscrowOffer(req, lim(k)); };
  it("control: the honest lock is signed", async () => {
    stubGateway([offer(k) as never]);
    await (await payer()).buyEscrowPack(BUY, { receiptKey: k, refundAddress: BUYER }, check);
    expect(signed).toHaveLength(1);
  });
  it("a refund-to-attacker datum is never signed (hook aborts)", async () => {
    stubGateway([offer(k, { buyerRefund: "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y" }) as never]);
    await expect((await payer()).buyEscrowPack(BUY, { receiptKey: k, refundAddress: BUYER }, check)).rejects.toThrow();
    expect(signed).toHaveLength(0);
  });
  it("two accepts (honest escrow first, attacker direct transfer second): only the checked one can be signed", async () => {
    stubGateway([direct("2000000"), offer(k) as never]);
    await (await payer()).buyEscrowPack(BUY, { receiptKey: k, refundAddress: BUYER }, check).catch(() => {});
    expect(signed.every((r) => (r.extra as Record<string, unknown>)?.assetTransferMethod === "script")).toBe(true);
  });
  it("the check is not left installed for a following direct purchase (no stale hook, no bypass)", async () => {
    stubGateway([offer(k) as never]);
    const p = await payer();
    await p.buyEscrowPack(BUY, { receiptKey: k, refundAddress: BUYER }, check);
    stubGateway([direct("2000000")]);
    await p.buyPack(BUY, { amount: 2_000_000n });
    expect(signed).toHaveLength(2);
  });
});
