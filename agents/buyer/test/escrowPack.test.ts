import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { decodeBody, inferRuleFromResponses, ruleHash, type RuleDefinition } from "@hirakumi/core";
import { PACK_ESCROW, encodePackDatum, newReceiptKey, verifyReceipt, type PackDatum } from "@hirakumi/escrow";
import { EscrowOfferError, IouKeyStore, checkEscrowOffer, escrowCall, signNext, type EscrowChannel, type Requirement } from "../src/escrowPack.js";
import { runEscrowPack } from "../src/escrowPackFlow.js";
import { json } from "./fakeGateway.js";

const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
const CHANNEL = "11".repeat(32);
const [POLICY, NAME] = USDM_PREPROD_ASSET.split(".") as [string, string];

const RULE: RuleDefinition = {
  version: 1, status: { min: 200, max: 299 }, contentType: "application/json",
  schema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
};

function datum(key: string, over: Partial<PackDatum> = {}): PackDatum {
  return {
    channelId: CHANNEL, receiptKey: key, buyerRefund: BUYER, seller: SELLER, policyId: POLICY, assetName: NAME,
    pricePerCall: 20_000n, maxCalls: 100n, ruleHash: "ab".repeat(32), feeAddress: FEE, feeBps: 300n, closer: "c1".repeat(28),
    contestPeriod: 180_000n, closeFeeBudget: 700_000n, stage: { kind: "open" }, ...over,
  };
}
function offer(key: string, d: Partial<PackDatum> = {}, r: Partial<Requirement> = {}, extra: Record<string, unknown> = {}): Requirement {
  return {
    scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount: "2000000", payTo: PACK_ESCROW.address,
    extra: { assetTransferMethod: "script", script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor }, datum: encodePackDatum(datum(key, d)), channelId: CHANNEL, ...extra },
    ...r,
  };
}
const lim = (key: string) => ({ receiptKey: key, refundAddress: BUYER, maxPackMicros: 5_000_000n });

describe("checkEscrowOffer: refuse to pay a datum that isn't ours", () => {
  const k = newReceiptKey().publicKey;
  it("accepts the expected lock", () => {
    expect(checkEscrowOffer(offer(k), lim(k)).channelId).toBe(CHANNEL);
  });
  it.each([
    ["a different refund address", offer(k, { buyerRefund: SELLER })],
    ["another receipt key", offer(newReceiptKey().publicKey)],
    ["another payTo", offer(k, {}, { payTo: SELLER })],
    ["another script", offer(k, {}, {}, { script: { type: "plutusV3", code: "00" } })],
    ["fee above 10%", offer(k, { feeBps: 1001n })],
    ["contest period too short", offer(k, { contestPeriod: 1000n })],
    ["price × calls ≠ amount", offer(k, { pricePerCall: 30_000n })],
    ["a close-fee budget above 2 ADA", offer(k, { closeFeeBudget: 3_000_000n })],
    ["not the script method", offer(k, {}, {}, { assetTransferMethod: "default" })],
    ["a channel id that disagrees with the datum", offer(k, {}, {}, { channelId: "22".repeat(32) })],
  ])("refuses %s", (_name, req) => {
    expect(() => checkEscrowOffer(req, lim(k))).toThrow(EscrowOfferError);
  });
  it("refuses a pack above the spend cap", () => {
    expect(() => checkEscrowOffer(offer(k), { ...lim(k), maxPackMicros: 1_000_000n })).toThrow(/cap/);
  });
});

function channel(store: IouKeyStore, over: Partial<EscrowChannel> = {}): EscrowChannel {
  const c = { ...store.ensure("api_demo", "pk_demo", BUYER, new Date("2026-10-06T00:00:00Z")), channelId: CHANNEL, token: "hk_test", ruleHash: ruleHash(RULE), ...over };
  store.put(c);
  return c;
}
const tmpStore = () => new IouKeyStore(join(mkdtempSync(join(tmpdir(), "iou-")), ".escrow-keys.json"));

describe("IOU key store", () => {
  it("is owner-only and resumes the same key after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iou-")), ".escrow-keys.json");
    const a = new IouKeyStore(path).ensure("api_demo", "pk_demo", BUYER, new Date());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new IouKeyStore(path).ensure("api_demo", "pk_demo", BUYER, new Date());
    expect(again.secretKey).toBe(a.secretKey);
  });
});

describe("signing", () => {
  it("never signs above the passes verified locally", () => {
    const c = channel(tmpStore(), { verifiedPasses: 2 });
    expect(signNext(c, 3)).toBeNull();
    const iou = signNext(c, 2)!;
    const [n, sig] = iou.split(".");
    expect(n).toBe("2");
    expect(verifyReceipt(c.publicKey, CHANNEL, 2, sig!)).toBe(true);
    expect(signNext({ ...c, disputed: true }, 1)).toBeNull();
  });
});

function gateway(responses: Array<() => Response>) {
  const seen: Array<Record<string, string>> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.includes("/r/")) return json(200, { ruleHash: ruleHash(RULE), definition: RULE });
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  };
  return { fetch, seen };
}
const rule = async () => RULE;

describe("escrowCall", () => {
  it("a pass checked locally gets IOU n; the next call carries it", async () => {
    const store = tmpStore();
    const c = channel(store);
    const g = gateway([() => json(200, { price: 1 }, { "x-hirakumi-sign-next": "1" }), () => json(200, { price: 2 }, { "x-hirakumi-sign-next": "2" })]);
    const r1 = await escrowCall({ fetch: g.fetch, rule, save: (x) => store.put(x) }, c, "https://gw.test/a/api_demo/x/getPrice");
    expect(r1).toMatchObject({ kind: "pass", signed: 1 });
    await escrowCall({ fetch: g.fetch, rule, save: (x) => store.put(x) }, c, "https://gw.test/a/api_demo/x/getPrice");
    expect(g.seen[1]!["x-hirakumi-iou"]).toMatch(/^1\.[0-9a-f]{128}$/);
    expect(store.get("api_demo", "pk_demo")!.lastSigned).toBe(2);
  });

  it("a gateway pass that fails our check is a dispute: nothing signed", async () => {
    const store = tmpStore();
    const c = channel(store);
    const g = gateway([() => json(200, { price: "not a number" }, { "x-hirakumi-sign-next": "1" })]);
    const r = await escrowCall({ fetch: g.fetch, rule, save: (x) => store.put(x) }, c, "https://gw.test/x");
    expect(r.kind).toBe("dispute");
    expect(store.get("api_demo", "pk_demo")).toMatchObject({ disputed: true, lastSigned: 0, lastIou: null });
  });

  it("checks a text answer against a text promise and returns it as text", async () => {
    const TEXT_RULE: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType: "text/csv", schema: { type: "string", minLength: 1, pattern: "^symbol,usd\\r?\\n" } };
    const store = tmpStore();
    const c = channel(store, { ruleHash: ruleHash(TEXT_RULE) });
    const csv = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/csv", "x-hirakumi-sign-next": "1" } });
    const g = gateway([csv("symbol,usd\nADA,0.27\n")]);
    const r = await escrowCall({ fetch: g.fetch, rule: async () => TEXT_RULE, save: (x) => store.put(x) }, c, "https://gw.test/x");
    expect(r).toEqual({ kind: "pass", body: "symbol,usd\nADA,0.27\n", contentType: "text/csv", signed: 1 });
    expect(g.seen[0]!.accept).toContain("text/*");
    const c2 = channel(tmpStore(), { ruleHash: ruleHash(TEXT_RULE) });
    const g2 = gateway([csv("wrong,header\n1,2\n")]);
    expect((await escrowCall({ fetch: g2.fetch, rule: async () => TEXT_RULE, save: () => {} }, c2, "https://gw.test/x")).kind).toBe("dispute");
  });

  it("agrees with the gateway on an inferred text promise: BOM-less text passes, blank and HTML pages are disputes", async () => {
    // The rule the coworker's QA infers from one CSV example called 5 times: no header pinned, so a new price passes.
    const textRule = inferRuleFromResponses(Array.from({ length: 5 }, () => ({ status: 200, contentType: "text/csv", body: "ADA 0.35\nupdated\n", latencyMs: 1 })));
    const csv = (body: string | Uint8Array) => () => new Response(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "x-hirakumi-sign-next": "1" } });
    const call = async (body: string | Uint8Array) => {
      const c = channel(tmpStore(), { ruleHash: ruleHash(textRule) });
      return escrowCall({ fetch: gateway([csv(body)]).fetch, rule: async () => textRule, save: () => {} }, c, "https://gw.test/x");
    };
    expect(await call("ADA 0.36\nupdated\n")).toMatchObject({ kind: "pass", body: "ADA 0.36\nupdated\n" });
    // res.text() drops a BOM just as the gateway's safeFetch does, so both check (and hash) the same string.
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("ADA 0.36\n")]);
    expect(decodeBody(withBom, "text/csv")).toBe(await new Response(withBom).text());
    expect(await call(withBom)).toMatchObject({ kind: "pass", body: "ADA 0.36\n" });
    expect((await call(" \n ")).kind).toBe("dispute");
    expect((await call("<!DOCTYPE html><html>502</html>")).kind).toBe("dispute");
  });

  it("402 iou_required: signs an earned IOU and retries once; never an unearned one", async () => {
    const store = tmpStore();
    const c = channel(store, { verifiedPasses: 1 });
    const g = gateway([() => json(402, { error: "iou_required", signNext: 1 }), () => json(200, { price: 1 }, { "x-hirakumi-sign-next": "2" })]);
    expect(await escrowCall({ fetch: g.fetch, rule, save: (x) => store.put(x) }, c, "https://gw.test/x")).toMatchObject({ kind: "pass", signed: 2 });
    expect(g.seen[1]!["x-hirakumi-iou"]).toMatch(/^1\./);
    const c2 = channel(tmpStore(), { verifiedPasses: 0 });
    const g2 = gateway([() => json(402, { error: "iou_required", signNext: 1 })]);
    expect(await escrowCall({ fetch: g2.fetch, rule, save: () => {} }, c2, "https://gw.test/x")).toEqual({ kind: "iou_required", signNext: 1 });
  });
});

describe("runEscrowPack", () => {
  it("checks the datum before paying and refuses a lock that refunds someone else", async () => {
    const store = tmpStore();
    const fetch = async (url: string) => {
      if (url.includes("/r/")) return json(200, { ruleHash: ruleHash(RULE), definition: RULE });
      return json(402, { error: "credits_required", packs: [{ packId: "pk_demo", calls: 100, price: "2000000", asset: USDM_PREPROD_ASSET, buyUrl: "/a/api_demo/packs/pk_demo" }], ruleHash: ruleHash(RULE), ruleUrl: "/r/x" });
    };
    let paid = false;
    const buyEscrowPack = async (_url: string, keys: { receiptKey: string; refundAddress: string }, check: (r: Requirement) => void) => {
      check(offer(keys.receiptKey, { buyerRefund: SELLER })); // a malicious gateway's datum
      paid = true;
      throw new Error("unreachable");
    };
    await expect(runEscrowPack(
      { fetch, buyEscrowPack: buyEscrowPack as never, store, refundAddress: BUYER, log: () => {}, sleep: async () => {}, now: () => new Date() },
      { gatewayUrl: "https://gw.test", apiId: "api_demo", opId: "getPrice", query: {}, calls: 1, intervalMs: 0, maxPackMicros: 5_000_000n, pendingTimeoutMs: 0, pendingPollMs: 0 },
    )).rejects.toThrow(EscrowOfferError);
    expect(paid).toBe(false);
  });
});
