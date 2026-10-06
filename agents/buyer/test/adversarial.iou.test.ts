// Malicious gateway, response side: IOU signing must follow the buyer's OWN verification. SAFE assertions only.
import { describe, expect, it } from "vitest";
import { ruleHash } from "@hirakumi/core";
import { closePayouts, parseIouHeader, verifyReceipt } from "@hirakumi/escrow";
import { escrowCall, signNext, type EscrowChannel, type IouKeyStore } from "../src/escrowPack.js";
import { closeEscrowPack, ruleFetcher, runEscrowPack } from "../src/escrowPackFlow.js";
import { PackPurchaseError } from "../src/payClient.js";
import { BUYER, CHANNEL, GW, LOOSE, STRICT, datum, flowOpts, maliciousEscrowGateway, offer, tmpStore } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

function channel(store: IouKeyStore, over: Partial<EscrowChannel> = {}): EscrowChannel {
  const c = { ...store.ensure("api_demo", "pk_demo", BUYER, new Date("2026-10-06T00:00:00Z")), channelId: CHANNEL, token: "hk_tok", ruleHash: ruleHash(STRICT), ...over };
  store.put(c);
  return c;
}
const strictRule = async () => STRICT;
const seq = (responses: Array<() => Response>) => {
  const seen: Array<Record<string, string>> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return responses.shift()!();
  };
  return { fetch, seen };
};
const signedCount = (iou: string | null | undefined) => (iou ? parseIouHeader(iou)!.accepted : 0);

describe("IOU signing vs a lying gateway", () => {
  it("200 whose body fails the rule but asks Sign-Next = 5: nothing signed, dispute", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 0 });
    const g = seq([() => json(200, { error: "rate limited" }, { "x-hirakumi-sign-next": "5" })]);
    const r = await escrowCall({ fetch: g.fetch, rule: strictRule, save: (x) => store.put(x) }, c, `${GW}/x`);
    expect(r.kind).toBe("dispute");
    expect(c.lastIou).toBeNull();
  });

  it("passing 200 but Sign-Next far above the passes seen: signs nothing above what was verified", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 2, lastSigned: 2 });
    for (const n of ["100", "4", "1e3", "Infinity", "-1", "3.5", "0x10", "  9  "]) {
      const g = seq([() => json(200, { price: 1 }, { "x-hirakumi-sign-next": n })]);
      await escrowCall({ fetch: g.fetch, rule: strictRule, save: () => {} }, c, `${GW}/x`);
      expect(c.lastSigned).toBeLessThanOrEqual(c.verifiedPasses);
    }
    expect(signedCount(c.lastIou)).toBeLessThanOrEqual(c.verifiedPasses);
  });

  it("402 iou_required for a count above verified passes: nothing new is signed, no retry loop", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 1 });
    const g = seq([() => json(402, { error: "iou_required", signNext: 50 })]);
    expect(await escrowCall({ fetch: g.fetch, rule: strictRule, save: () => {} }, c, `${GW}/x`)).toEqual({ kind: "iou_required", signNext: 50 });
    expect(c.lastIou).toBeNull();
    expect(g.seen).toHaveLength(1);
  });

  it("402 iou_required loop: the gateway can't make the buyer retry forever", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 1 });
    const g = seq(Array.from({ length: 10 }, () => () => json(402, { error: "iou_required", signNext: 1 })));
    await escrowCall({ fetch: g.fetch, rule: strictRule, save: () => {} }, c, `${GW}/x`);
    expect(g.seen.length).toBeLessThanOrEqual(2);
  });

  it("IOUs are always bound to the stored channel id (the gateway can't pick another channel)", () => {
    const c = channel(tmpStore(), { verifiedPasses: 3 });
    const iou = signNext(c, 3)!;
    const { accepted, signature } = parseIouHeader(iou)!;
    expect(verifyReceipt(c.publicKey, CHANNEL, accepted, signature)).toBe(true);
    expect(verifyReceipt(c.publicKey, "22".repeat(32), accepted, signature)).toBe(false);
  });

  it("a disputed channel never signs again, even for counts already earned", () => {
    const c = channel(tmpStore(), { verifiedPasses: 3, disputed: true });
    expect(signNext(c, 1)).toBeNull();
  });

  it("rule fetch: the gateway serves a LOOSE rule under the STRICT rule's hash (self-declared ruleHash)", async () => {
    // /r/<strict hash> answers { ruleHash: <strict hash>, definition: LOOSE }: the definition does not hash to it.
    const fetch = async () => json(200, { ruleHash: ruleHash(STRICT), definition: LOOSE });
    await expect(ruleFetcher(fetch, GW)(ruleHash(STRICT))).rejects.toThrow();
  });

  it("…and end to end: with that swapped rule the buyer signs IOUs for answers that break the published promise", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 0 });
    const rule = ruleFetcher(async () => json(200, { ruleHash: ruleHash(STRICT), definition: LOOSE }), GW);
    const g = seq([() => json(200, { error: "upstream down", price: null }, { "x-hirakumi-sign-next": "1" })]);
    const r = await escrowCall({ fetch: g.fetch, rule: async (h) => rule(h), save: (x) => store.put(x) }, c, `${GW}/x`).catch((e) => ({ kind: "error", e }));
    expect(r.kind).not.toBe("pass");
    expect(c.lastIou).toBeNull();
  });

  it("rule fetch: a non-matching ruleHash field is refused", async () => {
    const fetch = async () => json(200, { ruleHash: ruleHash(LOOSE), definition: LOOSE });
    await expect(ruleFetcher(fetch, GW)(ruleHash(STRICT))).rejects.toThrow(/could not fetch/);
  });

  it("replayed 200 (identical old body): UNPROVEN class — the buyer cannot tell, it counts it (documents behaviour)", async () => {
    // Freshness is only enforced if the rule carries maxAgeSeconds; STRICT has none. Documented, not asserted as a bug.
    const store = tmpStore();
    const c = channel(store);
    const old = () => json(200, { price: 1 }, { "x-hirakumi-sign-next": String(c.verifiedPasses + 1) });
    const g = seq([old, old]);
    await escrowCall({ fetch: g.fetch, rule: strictRule, save: () => {} }, c, `${GW}/x`);
    await escrowCall({ fetch: g.fetch, rule: strictRule, save: () => {} }, c, `${GW}/x`);
    expect(c.verifiedPasses).toBe(2);
  });
});

describe("purchase lifecycle vs a lying gateway", () => {
  const deps = (g: ReturnType<typeof maliciousEscrowGateway>, store = tmpStore()) => ({
    fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store, refundAddress: BUYER,
    log: () => {}, sleep: async () => {}, now: () => new Date("2026-10-06T00:00:00Z"),
  });

  it("gateway settles the lock, then answers 500: the buyer must keep a handle on the locked channel (to close it) before re-buying", async () => {
    const store = tmpStore();
    let lockedChannel: string | null = null;
    const g1 = maliciousEscrowGateway({
      lock: (key) => offer(key),
      purchase: (req) => {
        lockedChannel = datum("").channelId; // the lock tx with this datum is on-chain now
        return new PackPurchaseError(500, '{"error":"internal"}', "signed-payment-b64", "recovery-secret") as unknown as Error;
      },
    });
    await runEscrowPack(deps(g1, store), flowOpts(0)).catch(() => {});
    expect(lockedChannel).toBe(CHANNEL);
    // SAFE = the buyer can at least ask to close the 2 tUSDM it just locked.
    const logs: string[] = [];
    await expect(closeEscrowPack(
      { fetch: g1.fetch, store, log: (l) => logs.push(l), sleep: async () => {} },
      { gatewayUrl: GW, apiId: "api_demo", wait: false, pollMs: 0, timeoutMs: 0 },
    )).resolves.toBeDefined();
  });

  it("…and a re-run must not lock a second pack while the first payment is unaccounted for", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new PackPurchaseError(500, "internal", "sig", "sec") as unknown as Error });
    await runEscrowPack(deps(g1, store), flowOpts(0)).catch(() => {});
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key, { channelId: "33".repeat(32) }) });
    await runEscrowPack(deps(g2, store), flowOpts(0)).catch(() => {});
    expect(g1.state.checked + g2.state.paid).toBe(1); // checked = the first payment was signed
  });

  it("after a dispute, a re-run must not pay for a new pack it can never sign IOUs for", async () => {
    const store = tmpStore();
    // Run 1: one fake pass → dispute on CHANNEL.
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), calls: [() => json(200, { nope: true }, { "x-hirakumi-sign-next": "1" })] });
    const s1 = await runEscrowPack(deps(g1, store), flowOpts(1));
    expect(s1.disputed).toBe(true);
    // Run 2: the gateway sells a fresh pack (new channel) and serves honest passes.
    const NEW = "44".repeat(32);
    const pass = () => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" });
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key, { channelId: NEW }), purchase: () => ({ channelId: NEW }), calls: [pass, pass, pass] });
    const s2 = await runEscrowPack(deps(g2, store), flowOpts(3));
    // SAFE = either it doesn't pay, or the pack it paid for is usable (it signs IOUs for verified passes).
    expect(g2.state.paid === 0 || s2.signed > 0).toBe(true);
    // And it must not lose the handle on the disputed channel it still needs to close.
    expect(store.list("api_demo").some((c) => c.channelId === CHANNEL)).toBe(true);
  });

  it("a refused close (HTTP 500) is reported as a failure, not as 'close requested'", async () => {
    const store = tmpStore();
    channel(store, { verifiedPasses: 1 });
    const fetch = async () => json(500, { error: "nope" });
    await expect(closeEscrowPack(
      { fetch, store, log: () => {}, sleep: async () => {} },
      { gatewayUrl: GW, apiId: "api_demo", wait: false, pollMs: 0, timeoutMs: 0 },
    )).rejects.toThrow();
  });

  it("loss arithmetic for the calls bait-and-switch (100 advertised, 10 locked): seller takes 10× per call", () => {
    const d = datum("00".repeat(32), { pricePerCall: 200_000n, maxCalls: 10n });
    const p = closePayouts(d, 2_000_000n, 10n);
    expect(p.sellerGross).toBe(2_000_000n); // 10 calls cost the whole 2 tUSDM; advertised: 10 × 0.02 = 0.2 tUSDM
  });
});
