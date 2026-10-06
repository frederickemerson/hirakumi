// Lost purchase answers, close-auth and key slots: the buyer never loses a paid lock and never pays twice.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newReceiptKey, verifyCloseRequest } from "@hirakumi/escrow";
import { checkEscrowOffer, EscrowOfferError, IouKeyStore } from "../src/escrowPack.js";
import { closeEscrowPack, runEscrowPack } from "../src/escrowPackFlow.js";
import { PackPurchaseError, PaymentNotSentError, directPackCheck } from "../src/payClient.js";
import { writePrivateJson } from "../src/tokenStore.js";
import { BUYER, CHANNEL, GW, flowOpts, lim, maliciousEscrowGateway, offer, tmpDir, tmpStore } from "./adversarial.helpers.js";
import { json } from "./fakeGateway.js";

const deps = (g: ReturnType<typeof maliciousEscrowGateway>, store = tmpStore(), logs: string[] = []) => ({
  fetch: g.fetch, buyEscrowPack: g.buyEscrowPack, store, refundAddress: BUYER,
  log: (l: string) => { logs.push(l); }, sleep: async () => {}, now: () => new Date("2026-10-06T00:00:00Z"),
});
const close = (fetch: (url: string, init?: RequestInit) => Promise<Response>, store: IouKeyStore, packIds?: string[]) =>
  closeEscrowPack({ fetch, store, log: () => {}, sleep: async () => {} }, { gatewayUrl: GW, apiId: "api_demo", packIds, wait: false, pollMs: 0, timeoutMs: 0 });

describe("checkEscrowOffer with the chosen pack", () => {
  const k = newReceiptKey().publicKey;
  it("accepts the exact pack and refuses other calls, price or promise", () => {
    const req = offer(k);
    const d = checkEscrowOffer(req, lim(k));
    const expected = { calls: 100, priceMicros: 2_000_000n, ruleHash: `sha256:${d.ruleHash}` };
    expect(checkEscrowOffer(req, lim(k), expected).channelId).toBe(CHANNEL);
    expect(() => checkEscrowOffer(req, lim(k), { ...expected, calls: 50 })).toThrow(/calls/);
    expect(() => checkEscrowOffer(req, lim(k), { ...expected, priceMicros: 1_000_000n })).toThrow(/price/);
    expect(() => checkEscrowOffer(req, lim(k), { ...expected, ruleHash: `sha256:${"00".repeat(32)}` })).toThrow(/promise/);
  });
  it("refuses upper-case datum hex (not the bytes that were validated)", () => {
    const req = offer(k);
    expect(() => checkEscrowOffer({ ...req, extra: { ...req.extra, datum: (req.extra!.datum as string).toUpperCase() } }, lim(k))).toThrow(EscrowOfferError);
  });
});

describe("lost purchase answer", () => {
  it("records the channel before paying, then recovers the token on the next run (no second lock)", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new PackPurchaseError(500, "internal", "sig", "sec") as unknown as Error });
    await expect(runEscrowPack(deps(g1, store), flowOpts(0))).rejects.toThrow(PackPurchaseError);
    const rec = store.get("api_demo", "pk_demo")!;
    expect(rec).toMatchObject({ channelId: CHANNEL, token: null, pendingPayment: { paymentSignature: "sig", recoverySecret: "sec", buyUrl: `${GW}/a/api_demo/packs/pk_demo` } });

    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key, { channelId: "33".repeat(32) }), calls: [() => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" })] });
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return url.endsWith("/recover") ? json(200, { token: "hk_recovered", status: "active", credits: 100 }) : g2.fetch(url, init);
    };
    const logs: string[] = [];
    const s = await runEscrowPack({ ...deps(g2, store, logs), fetch }, flowOpts(1));
    expect(g2.state.paid).toBe(0);
    expect(s.channelId).toBe(CHANNEL);
    expect(s.signed).toBe(1);
    const rec2 = seen.find((x) => x.url.endsWith("/recover"))!;
    expect(rec2.headers.get("payment-signature")).toBe("sig");
    expect(rec2.headers.get("x-hirakumi-recovery-secret")).toBe("sec");
    expect(store.get("api_demo", "pk_demo")).toMatchObject({ token: "hk_recovered", pendingPayment: null });
    expect(logs.join("\n")).not.toContain("hk_recovered");
    expect(logs.join("\n")).not.toContain("sec\"");
  });

  it("without a saved payment the next run refuses to buy and says to run --close", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new Error("socket hang up") });
    await runEscrowPack(deps(g1, store), flowOpts(0)).catch(() => {});
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await expect(runEscrowPack(deps(g2, store), flowOpts(0))).rejects.toThrow(/Run --close/);
    expect(g2.state.paid).toBe(0);
  });

  it("a purchase that failed before anything was signed forgets the channel (re-buy is fine)", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new PaymentNotSentError(new Error("network")) });
    await expect(runEscrowPack(deps(g1, store), flowOpts(0))).rejects.toThrow(PaymentNotSentError);
    expect(store.get("api_demo", "pk_demo")).toMatchObject({ channelId: null, token: null });
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await runEscrowPack(deps(g2, store), flowOpts(0));
    expect(g2.state.paid).toBe(1);
  });
});

describe("--close", () => {
  it("token-less: signs a close request with the channel's IOU key; once accepted the channel stops blocking", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new Error("lost") });
    await runEscrowPack(deps(g1, store), flowOpts(0)).catch(() => {});
    const rec = store.get("api_demo", "pk_demo")!;
    let headers = new Headers();
    let url = "";
    await close(async (u, init) => { url = u; headers = new Headers(init?.headers); return json(202, { status: "closing" }); }, store);
    expect(url).toBe(`${GW}/a/api_demo/channels/${CHANNEL}/close`);
    expect(headers.get("authorization")).toBeNull();
    expect(verifyCloseRequest(rec.publicKey, CHANNEL, headers.get("x-hirakumi-close-auth")!)).toBe(true);
    expect(store.get("api_demo", "pk_demo")!.closeRequested).toBe(true);
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key, { channelId: "55".repeat(32) }), purchase: () => ({ channelId: "55".repeat(32) }) });
    await runEscrowPack(deps(g2, store), flowOpts(0));
    expect(g2.state.paid).toBe(1);
    expect(store.list("api_demo").map((c) => c.channelId).sort()).toEqual([CHANNEL, "55".repeat(32)].sort());
  });

  it("with a token: uses the bearer", async () => {
    const store = tmpStore();
    const g = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await runEscrowPack(deps(g, store), flowOpts(0));
    let headers = new Headers();
    await close(async (_u, init) => { headers = new Headers(init?.headers); return json(200, { status: "closing" }); }, store);
    expect(headers.get("authorization")).toBe("Bearer hk_tok");
    expect(headers.get("x-hirakumi-close-auth")).toBeNull();
  });

  it("token-less + 404 channel_not_found: marks it abandoned; other refusals throw", async () => {
    const store = tmpStore();
    const g1 = maliciousEscrowGateway({ lock: (key) => offer(key), purchase: () => new Error("lost") });
    await runEscrowPack(deps(g1, store), flowOpts(0)).catch(() => {});
    await expect(close(async () => json(403, { error: "not_your_channel" }), store)).rejects.toThrow(/close refused: HTTP 403/);
    await close(async () => json(404, { error: "channel_not_found" }), store);
    expect(store.get("api_demo", "pk_demo")!.abandoned).toBe(true);
    await expect(close(async () => json(200, {}), store)).rejects.toThrow(/no escrow channel/);
  });

  it("409 for a refused channel (its lock never landed) is final: marked abandoned, not a stuck error", async () => {
    const store = tmpStore();
    const g = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await runEscrowPack(deps(g, store), flowOpts(0));
    await close(async () => json(409, { error: "channel_not_locked", status: "refused" }), store);
    expect(store.get("api_demo", "pk_demo")!.abandoned).toBe(true);
    // A 409 while the lock is merely pending is not final.
    const store2 = tmpStore();
    const g2 = maliciousEscrowGateway({ lock: (key) => offer(key) });
    await runEscrowPack(deps(g2, store2), flowOpts(0));
    await expect(close(async () => json(409, { error: "channel_not_locked", status: "pending" }), store2)).rejects.toThrow(/close refused: HTTP 409/);
  });

  it("picks the newest channel, archived ones included", async () => {
    const store = tmpStore();
    const a = store.ensure("api_demo", "pk_demo", BUYER, new Date("2026-10-01T00:00:00Z"));
    store.put({ ...a, channelId: "aa".repeat(32), token: "t1" });
    const b = store.ensure("api_demo", "pk_demo", BUYER, new Date("2026-10-02T00:00:00Z"));
    store.put({ ...b, channelId: "bb".repeat(32), token: "t2" });
    expect(store.list("api_demo")).toHaveLength(2);
    let url = "";
    await close(async (u) => { url = u; return json(200, { status: "closing" }); }, store, ["pk_demo"]);
    expect(url).toContain("bb".repeat(32));
  });
});

describe("IouKeyStore.ensure", () => {
  it("reuses an unbound key, archives a bound one (never overwrites it)", () => {
    const store = tmpStore();
    const a = store.ensure("api_demo", "pk_demo", BUYER, new Date());
    expect(store.ensure("api_demo", "pk_demo", BUYER, new Date()).publicKey).toBe(a.publicKey);
    store.put({ ...a, channelId: CHANNEL, disputed: true });
    const b = store.ensure("api_demo", "pk_demo", BUYER, new Date());
    expect(b.publicKey).not.toBe(a.publicKey);
    expect(store.get("api_demo", "pk_demo")!.publicKey).toBe(b.publicKey);
    const archived = store.list("api_demo").find((c) => c.channelId === CHANNEL)!;
    expect(archived).toMatchObject({ publicKey: a.publicKey, disputed: true });
    // Saving the archived record updates it in place, not the current slot.
    store.put({ ...archived, abandoned: true });
    expect(store.get("api_demo", "pk_demo")!.publicKey).toBe(b.publicKey);
    expect(store.list("api_demo")).toHaveLength(2);
  });
});

describe("directPackCheck", () => {
  const req = { scheme: "exact", network: "cardano:preprod", asset: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d", amount: "2000000", payTo: BUYER };
  it("needs the exact amount, tUSDM and a plain transfer", async () => {
    const { USDM_PREPROD_ASSET } = await import("@x402/cardano");
    const ok = { ...req, asset: USDM_PREPROD_ASSET };
    expect(() => directPackCheck({ amount: 2_000_000n })(ok)).not.toThrow();
    expect(() => directPackCheck({ amount: 1_000_000n })(ok)).toThrow(/amount/);
    expect(() => directPackCheck({ amount: 2_000_000n })(req)).toThrow(/tUSDM/);
    expect(() => directPackCheck({ amount: 2_000_000n })({ ...ok, extra: { assetTransferMethod: "script" } })).toThrow(/script/);
  });
});

describe("writePrivateJson", () => {
  it("writes 0600 and leaves no temp files", () => {
    const p = join(tmpDir(), "sub", "x.json");
    writePrivateJson(p, { a: 1 });
    writePrivateJson(p, { a: 2 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(dirname(p))).toEqual(["x.json"]);
  });
});
