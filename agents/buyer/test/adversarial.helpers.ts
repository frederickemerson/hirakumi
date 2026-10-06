// Shared fixtures for the adversarial (malicious gateway) tests. Nothing here touches the network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { ruleHash, type RuleDefinition } from "@hirakumi/core";
import { PACK_ESCROW, encodePackDatum, type PackDatum } from "@hirakumi/escrow";
import { IouKeyStore, type Requirement } from "../src/escrowPack.js";
import type { EscrowPurchase, OfferCheck } from "../src/payClient.js";
import { json } from "./fakeGateway.js";

export const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
export const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
export const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
export const CHANNEL = "11".repeat(32);
export const [POLICY, NAME] = USDM_PREPROD_ASSET.split(".") as [string, string];
export const GW = "https://gw.test";

/** The promise the seller published: an object with a numeric price. */
export const STRICT: RuleDefinition = {
  version: 1, status: { min: 200, max: 299 }, contentType: "application/json",
  schema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
};
/** A looser rule a malicious gateway would like the buyer to check against instead: anything goes. */
export const LOOSE: RuleDefinition = { version: 1, status: { min: 200, max: 299 }, contentType: "application/json", schema: {} };
export const hexOfRule = (r: RuleDefinition) => ruleHash(r).replace(/^sha256:/, "");

export function datum(key: string, over: Partial<PackDatum> = {}): PackDatum {
  return {
    channelId: CHANNEL, receiptKey: key, buyerRefund: BUYER, seller: SELLER, policyId: POLICY, assetName: NAME,
    pricePerCall: 20_000n, maxCalls: 100n, ruleHash: hexOfRule(STRICT), feeAddress: FEE, feeBps: 300n, closer: "c1".repeat(28),
    contestPeriod: 180_000n, closeFeeBudget: 700_000n, stage: { kind: "open" }, ...over,
  };
}

export function offer(key: string, d: Partial<PackDatum> = {}, r: Partial<Requirement> = {}, extra: Record<string, unknown> = {}): Requirement {
  const dd = datum(key, d);
  return {
    scheme: "exact", network: "cardano:preprod", asset: USDM_PREPROD_ASSET, amount: "2000000", payTo: PACK_ESCROW.address,
    extra: { assetTransferMethod: "script", script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor }, datum: encodePackDatum(dd), channelId: dd.channelId, ...extra },
    ...r,
  };
}

export const lim = (key: string) => ({ receiptKey: key, refundAddress: BUYER, maxPackMicros: 5_000_000n });
export const tmpDir = () => mkdtempSync(join(tmpdir(), "hk-adv-"));
export const tmpStore = () => new IouKeyStore(join(tmpDir(), ".escrow-keys.json"));

export type PackListing = { packId: string; calls: number; price: string; asset?: string };

/**
 * A malicious gateway for runEscrowPack. `listing` is what the unauthenticated 402 advertises; `lock` builds the
 * x402 requirement it actually asks the buyer to pay (from the buyer's own receipt key); `purchase` is what it
 * answers after payment; `calls` answers each paid call; `rules` answers /r/<hash>.
 */
export function maliciousEscrowGateway(o: {
  listing?: PackListing[];
  offerRuleHash?: string;
  lock: (receiptKey: string) => Requirement;
  purchase?: (req: Requirement) => Partial<EscrowPurchase> | Error;
  calls?: Array<() => Response>;
  rules?: (hash: string) => Response;
}) {
  const state = { paid: 0, checked: 0, iouHeaders: [] as (string | null)[], logs: [] as string[] };
  const calls = [...(o.calls ?? [])];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.includes("/r/")) {
      const hash = decodeURIComponent(url.split("/r/")[1]!);
      return o.rules ? o.rules(hash) : json(200, { ruleHash: hash, definition: STRICT });
    }
    if (url.includes("/close")) return json(200, { status: "closing" });
    const h = new Headers(init?.headers);
    if (!h.get("authorization")) {
      return json(402, {
        error: "credits_required",
        packs: (o.listing ?? [{ packId: "pk_demo", calls: 100, price: "2000000" }]).map((p) => ({
          asset: USDM_PREPROD_ASSET, buyUrl: `/a/api_demo/packs/${p.packId}`, ...p,
        })),
        ruleHash: o.offerRuleHash ?? ruleHash(STRICT), ruleUrl: "/r/x",
      });
    }
    state.iouHeaders.push(h.get("x-hirakumi-iou"));
    const next = calls.shift();
    return next ? next() : json(402, { error: "credits_exhausted" });
  };
  const buyEscrowPack = async (_url: string, keys: { receiptKey: string; refundAddress: string }, check: OfferCheck): Promise<EscrowPurchase> => {
    const req = o.lock(keys.receiptKey);
    check(req); // throws when the buyer refuses: nothing is signed
    state.checked++;
    const p = o.purchase?.(req);
    if (p instanceof Error) throw p;
    state.paid++;
    const escrow = req.payTo === PACK_ESCROW.address;
    return { token: "hk_tok", credits: 100, apiId: "api_demo", txHash: "aa".repeat(32), mode: escrow ? "escrow" : "direct", channelId: escrow ? CHANNEL : null, channelUrl: null, ...p };
  };
  return { fetch, buyEscrowPack, state };
}

export const flowOpts = (calls = 1) => ({
  gatewayUrl: GW, apiId: "api_demo", opId: "getPrice", query: {}, calls, intervalMs: 0,
  maxPackMicros: 5_000_000n, pendingTimeoutMs: 0, pendingPollMs: 0,
});
