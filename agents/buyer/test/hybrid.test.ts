// A hybrid gateway (PACK_MODE=hybrid) says in extra.settlement.mode how a pack settles. The buyer follows it,
// still checks every escrow offer in full, and pays a seller directly only up to its own cap.
import { describe, expect, it } from "vitest";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { PACK_ESCROW, newReceiptKey } from "@hirakumi/escrow";
import { DEFAULT_MAX_DIRECT_MICROS, EscrowOfferError, checkDirectOffer, offerMode, type Requirement } from "../src/escrowPack.js";
import { runEscrowPack } from "../src/escrowPackFlow.js";
import { PackPurchaseError } from "../src/payClient.js";
import { BUYER, SELLER, flowOpts, maliciousEscrowGateway, offer, tmpStore } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

const direct = (amount = "2000000", over: Partial<Requirement> = {}, extra: Record<string, unknown> = {}): Requirement => ({
  scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount, payTo: SELLER,
  extra: { apiId: "api_demo", packId: "pk_demo", settlement: { mode: "direct", reasons: ["small pack", "proven seller"] }, ...extra },
  ...over,
});
const withSettlement = (r: Requirement, mode: string, reasons: string[]) => ({ ...r, extra: { ...r.extra, settlement: { mode, reasons } } });
const deps = (g: ReturnType<typeof maliciousEscrowGateway>, store = tmpStore(), logs: string[] = []) => ({
  fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store, refundAddress: BUYER,
  log: (l: string) => { logs.push(l); }, sleep: async () => {}, now: () => new Date("2026-10-06T00:00:00Z"),
});

describe("offerMode / checkDirectOffer", () => {
  it("only an explicit direct is direct; no word (a PACK_MODE=escrow gateway) is escrow", () => {
    expect(offerMode(direct())).toBe("direct");
    expect(offerMode(offer(newReceiptKey().publicKey))).toBe("escrow");
    expect(offerMode(direct("2000000", {}, { settlement: { mode: "anything" } }))).toBe("escrow");
  });
  it("pays exactly the chosen price, as a plain transfer, never to the escrow, never above the direct cap", () => {
    expect(() => checkDirectOffer(direct(), { priceMicros: 2_000_000n })).not.toThrow();
    expect(() => checkDirectOffer(direct("3000000"), { priceMicros: 2_000_000n })).toThrow(/chosen pack's price/);
    expect(() => checkDirectOffer(direct("2000000", {}, { assetTransferMethod: "script" }), { priceMicros: 2_000_000n })).toThrow(/script/);
    expect(() => checkDirectOffer(direct("2000000", { payTo: PACK_ESCROW.address }), { priceMicros: 2_000_000n })).toThrow(EscrowOfferError);
    expect(() => checkDirectOffer(direct("6000000"), { priceMicros: 6_000_000n })).toThrow(/direct cap of 5 tUSDM/);
    expect(() => checkDirectOffer(direct("6000000"), { priceMicros: 6_000_000n }, 10_000_000n)).not.toThrow();
    expect(DEFAULT_MAX_DIRECT_MICROS).toBe(5_000_000n);
  });
});

describe("runEscrowPack against a hybrid gateway", () => {
  it("direct: pays the seller, keeps a plain token, checks answers locally, signs nothing", async () => {
    const logs: string[] = [];
    const g = maliciousEscrowGateway({ lock: () => direct(), calls: [() => json(200, { price: 1 }), () => json(200, { price: 2 })] });
    const d = deps(g, tmpStore(), logs);
    const s = await runEscrowPack(d, flowOpts(2));
    expect(g.state.paid).toBe(1);
    expect(s).toMatchObject({ channelId: null, passed: 2, signed: 0, disputed: false });
    expect(g.state.iouHeaders).toEqual([null, null]);
    expect(d.store.get("api_demo", "pk_demo")).toMatchObject({ direct: true, token: "hk_tok", channelId: null });
    expect(logs.join("\n")).toContain("Settlement: direct, because: small pack, proven seller.");
  });

  it("direct above our direct cap is refused (even under the escrow cap): nothing paid", async () => {
    const g = maliciousEscrowGateway({ listing: [{ packId: "pk_demo", calls: 100, price: "6000000" }], lock: () => direct("6000000") });
    await expect(runEscrowPack(deps(g), { ...flowOpts(0), maxPackMicros: 10_000_000n })).rejects.toThrow(/direct cap/);
    expect(g.state.paid).toBe(0);
  });

  it("direct with a raised cap is paid", async () => {
    const g = maliciousEscrowGateway({ listing: [{ packId: "pk_demo", calls: 100, price: "6000000" }], lock: () => direct("6000000") });
    await runEscrowPack(deps(g), { ...flowOpts(0), maxPackMicros: 10_000_000n, maxDirectMicros: 10_000_000n });
    expect(g.state.paid).toBe(1);
  });

  it("a 'direct' offer that pays the escrow or asks another price is refused", async () => {
    for (const lock of [() => direct("2000000", { payTo: PACK_ESCROW.address }), () => direct("2500000")]) {
      const g = maliciousEscrowGateway({ lock });
      await expect(runEscrowPack(deps(g), flowOpts(0))).rejects.toThrow(/refusing to pay/);
      expect(g.state.paid).toBe(0);
    }
  });

  it("escrow with reasons: the full datum check still runs (a foreign refund address is refused)", async () => {
    const bad = maliciousEscrowGateway({ lock: (key) => withSettlement(offer(key, { buyerRefund: SELLER }), "escrow", ["new seller"]) });
    await expect(runEscrowPack(deps(bad), flowOpts(0))).rejects.toThrow(EscrowOfferError);
    expect(bad.state.paid).toBe(0);
    const logs: string[] = [];
    const ok = maliciousEscrowGateway({ lock: (key) => withSettlement(offer(key), "escrow", ["new seller"]), calls: [() => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" })] });
    const s = await runEscrowPack(deps(ok, tmpStore(), logs), flowOpts(1));
    expect(s).toMatchObject({ signed: 1 });
    expect(logs.join("\n")).toContain("Settlement: escrow, because: new seller.");
  });

  it("a lost direct purchase answer is saved and recovered on the next run (no second payment)", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: () => direct(), purchase: () => new PackPurchaseError(500, "internal", "sig", "sec") as unknown as Error });
    await expect(runEscrowPack(deps(g1, store), flowOpts(0))).rejects.toThrow();
    expect(store.get("api_demo", "pk_demo")).toMatchObject({ direct: true, token: null, pendingPayment: { paymentSignature: "sig", recoverySecret: "sec" } });
    let recovered = 0;
    const g2 = maliciousEscrowGateway({ lock: () => direct() });
    const fetch2 = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/recover")) { recovered++; return json(200, { token: "hk_recovered" }); }
      return g2.fetch(url, init);
    };
    await runEscrowPack({ ...deps(g2, store), fetch: fetch2 }, flowOpts(0));
    expect(recovered).toBe(1);
    expect(g2.state.paid).toBe(0);
    expect(store.get("api_demo", "pk_demo")).toMatchObject({ token: "hk_recovered", pendingPayment: null });
  });

  it("after a direct pack, the next escrow purchase gets a fresh key and the direct record is kept", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: () => direct(), calls: [() => json(402, { error: "credits_exhausted" })] });
    await runEscrowPack(deps(g1, store), flowOpts(0));
    const first = store.get("api_demo", "pk_demo")!;
    first.disputed = true; // stand-in for "used up": storedFor no longer returns it
    store.put(first);
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await runEscrowPack(deps(g2, store), flowOpts(0));
    expect(store.get("api_demo", "pk_demo")!.publicKey).not.toBe(first.publicKey);
    expect(store.list("api_demo").some((c) => c.direct && c.publicKey === first.publicKey)).toBe(true);
  });
});

describe("runEscrowPack with requireEscrow (X-Hirakumi-Settlement: escrow)", () => {
  it("asks for escrow and pays the escrow offer after the full datum check", async () => {
    const g = maliciousEscrowGateway({ lock: (k) => offer(k), calls: [() => json(200, { price: 1 })] });
    const s = await runEscrowPack(deps(g), { ...flowOpts(1), requireEscrow: true });
    expect(g.state.asked).toEqual(["escrow"]);
    expect(g.state.paid).toBe(1);
    expect(s.channelId).not.toBeNull();
  });

  it("refuses a direct offer, however small: nothing paid", async () => {
    const g = maliciousEscrowGateway({ lock: () => direct("1000000") });
    await expect(runEscrowPack(deps(g), { ...flowOpts(0), requireEscrow: true })).rejects.toThrow(/asked for escrow/);
    expect(g.state.paid).toBe(0);
  });

  it("without it, the buyer states no preference", async () => {
    const g = maliciousEscrowGateway({ lock: () => direct() });
    await runEscrowPack(deps(g), flowOpts(0));
    expect(g.state.asked).toEqual([null]);
  });
});
