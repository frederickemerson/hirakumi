// Independent verifier: bypass attempts on H2/H3/L1 (promise + pack binding) and the M2 recovery path.
import { describe, expect, it } from "vitest";
import { ruleHash } from "@hirakumi/core";
import { newReceiptKey, verifyReceipt } from "@hirakumi/escrow";
import { checkEscrowOffer, EscrowOfferError } from "../src/escrowPack.js";
import { ruleFetcher, runEscrowPack } from "../src/escrowPackFlow.js";
import { PackPurchaseError } from "../src/payClient.js";
import { BUYER, CHANNEL, GW, LOOSE, STRICT, flowOpts, hexOfRule, lim, maliciousEscrowGateway, offer, tmpStore } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

const deps = (g: ReturnType<typeof maliciousEscrowGateway>, store = tmpStore()) => ({
  fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store, refundAddress: BUYER,
  log: () => {}, sleep: async () => {}, now: () => new Date("2026-10-06T00:00:00Z"),
});

describe("verify: rule hash spelling tricks", () => {
  const k = newReceiptKey().publicKey;
  const exact = { calls: 100, priceMicros: 2_000_000n, ruleHash: ruleHash(STRICT) };
  it("the offer's promise must match the datum exactly (no bare hex, no upper case, no other prefix)", () => {
    expect(checkEscrowOffer(offer(k), lim(k), exact).ruleHash).toBe(hexOfRule(STRICT));
    for (const rh of [hexOfRule(STRICT), ruleHash(STRICT).toUpperCase(), `SHA256:${hexOfRule(STRICT)}`, `sha256:${hexOfRule(STRICT)} `, ruleHash(LOOSE)]) {
      expect(() => checkEscrowOffer(offer(k), lim(k), { ...exact, ruleHash: rh }), rh).toThrow(EscrowOfferError);
    }
  });

  it("ruleFetcher refuses a definition for any hash spelling but the canonical one, whatever the gateway's ruleHash field says", async () => {
    const serve = (def: unknown, claimed: (h: string) => string) => async (url: string) => {
      const hash = decodeURIComponent(url.split("/r/")[1]!);
      return json(200, { ruleHash: claimed(hash), definition: def });
    };
    const canon = ruleHash(STRICT);
    for (const asked of [canon.toUpperCase(), canon.replace(/^sha256:/, ""), canon + "00"]) {
      await expect(ruleFetcher(serve(STRICT, (h) => h), GW)(asked), asked).rejects.toThrow();
    }
    await expect(ruleFetcher(serve(LOOSE, (h) => h), GW)(canon)).rejects.toThrow();
    // Key order doesn't change the canonical hash: a reordered but equal definition is fine (liveness).
    const reordered = JSON.parse(JSON.stringify({ schema: STRICT.schema, contentType: STRICT.contentType, status: STRICT.status, version: STRICT.version }));
    await expect(ruleFetcher(serve(reordered, (h) => h), GW)(canon)).resolves.toBeDefined();
  });

  it("a listing promise of LOOSE with a STRICT datum (or the reverse) is refused before paying", async () => {
    const g = maliciousEscrowGateway({ offerRuleHash: ruleHash(LOOSE), lock: (key) => offer(key) });
    await expect(runEscrowPack(deps(g), flowOpts(1))).rejects.toThrow(/promise/);
    expect(g.state.paid).toBe(0);
  });
});

describe("verify: M2 recovery cannot be turned against the buyer", () => {
  it("a /recover token for some other channel never makes the buyer sign IOUs for that channel or above its verified passes", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new PackPurchaseError(500, "internal", "sig", "sec") as unknown as Error });
    await expect(runEscrowPack(deps(g1, store), flowOpts(0))).rejects.toThrow();
    const rec = store.get("api_demo", "pk_demo")!;
    // Next run: the gateway "recovers" a token belonging to another channel and asks to sign 50.
    const g2 = maliciousEscrowGateway({
      lock: (key) => offer(key, { channelId: "77".repeat(32) }),
      calls: [() => json(200, { price: 1 }, { "x-hirakumi-sign-next": "50" }), () => json(200, { price: 2 }, { "x-hirakumi-sign-next": "2" })],
    });
    const fetch = async (url: string, init?: RequestInit) =>
      url.endsWith("/recover") ? json(200, { token: "hk_other_channel", channelId: "77".repeat(32) }) : g2.fetch(url, init);
    const s = await runEscrowPack({ ...deps(g2, store), fetch }, flowOpts(2));
    expect(g2.state.paid).toBe(0);
    expect(s.channelId).toBe(CHANNEL);
    const after = store.list("api_demo").find((c) => c.publicKey === rec.publicKey)!;
    expect(after.lastSigned).toBeLessThanOrEqual(after.verifiedPasses);
    const [n, sig] = after.lastIou!.split(".");
    expect(verifyReceipt(rec.publicKey, CHANNEL, Number(n), sig!)).toBe(true);
    expect(verifyReceipt(rec.publicKey, "77".repeat(32), Number(n), sig!)).toBe(false);
  });
});
