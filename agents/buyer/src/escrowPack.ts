// Escrow packs, buyer side: check the 402 datum before paying, keep the IOU key, re-check every passing
// answer against the published promise locally, and sign an IOU only for passes we verified ourselves.
import { readFileSync } from "node:fs";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { compileRule, type RuleDefinition } from "@hirakumi/core";
import {
  MAX_CLOSE_FEE_BUDGET, MAX_CONTEST_PERIOD_MS, MIN_CONTEST_PERIOD_MS, PACK_ESCROW, decodePackDatum, encodePackDatum, newReceiptKey,
  signCloseRequest, signReceipt, validateDatumForLock, type PackDatum,
} from "@hirakumi/escrow";
import { ANSWER_ACCEPT, answerBody, formatMicros, safeJson, type FetchLike } from "./gatewayClient.js";
import { directPackCheck } from "./payClient.js";
import { writePrivateJson } from "./tokenStore.js";

export const MAX_FEE_BPS = 1000n;
/** We pay a seller directly (no escrow, no refund) for at most this much per pack: 5 tUSDM. */
export const DEFAULT_MAX_DIRECT_MICROS = 5_000_000n;

export class EscrowOfferError extends Error {}

/** The parts of an x402 PaymentRequirements the check reads. */
export type Requirement = { scheme: string; network: string; asset: string; amount: string; payTo: string; extra?: Record<string, unknown> };

export type OfferLimits = { receiptKey: string; refundAddress: string; maxPackMicros: bigint; maxFeeBps?: bigint; maxContestMs?: bigint };

/** The pack the buyer chose: calls and price from the listing, the promise ("sha256:…") from the 402 offer. */
export type ExpectedPack = { calls: number; priceMicros: bigint; ruleHash: string };

/**
 * Refuses to pay unless the lock would be exactly what we expect: the known escrow script and address, our
 * IOU key and refund address in the datum, price = per-call × calls = amount, a sane fee, contest period
 * and close-fee budget. A malicious gateway can't redirect the refund or change the terms.
 * With `expect` (the pack the buyer chose from the listing), the lock must also be exactly that pack: same
 * number of calls, same price, and the same promise (rule hash) the buyer will check answers against.
 */
export function checkEscrowOffer(req: Requirement, lim: OfferLimits, expect?: ExpectedPack): PackDatum {
  const fail = (m: string): never => { throw new EscrowOfferError(`refusing to pay: ${m}`); };
  if (req.scheme !== "exact" || req.network !== "cardano:preprod") fail(`unexpected scheme/network ${req.scheme} ${req.network}`);
  if (req.asset !== USDM_PREPROD_ASSET) fail(`asset ${req.asset} is not tUSDM`);
  if (req.payTo !== PACK_ESCROW.address) fail(`payTo ${req.payTo} is not the pack_escrow address`);
  const extra = req.extra ?? {};
  if (extra.assetTransferMethod !== "script") fail("assetTransferMethod is not script");
  const script = extra.script as { type?: unknown; code?: unknown } | undefined;
  if (script?.type !== "plutusV3" || script.code !== PACK_ESCROW.scriptCbor) fail("the script is not the known pack_escrow validator");
  if (typeof extra.datum !== "string") fail("no inline datum");
  let d: PackDatum;
  try { d = decodePackDatum(extra.datum as string); } catch (e) { return fail(`datum does not decode: ${(e as Error).message}`); }
  // The bytes that go on-chain must be exactly the datum we validated (no alternative CBOR encodings).
  if (encodePackDatum(d) !== extra.datum) fail("datum is not canonically encoded");
  if (d.receiptKey !== lim.receiptKey.toLowerCase()) fail("the datum's receipt key is not ours");
  if (d.buyerRefund !== lim.refundAddress) fail(`the datum refunds ${d.buyerRefund}, not our address`);
  if (`${d.policyId}.${d.assetName}` !== USDM_PREPROD_ASSET) fail("the datum's asset is not the paid asset");
  if (!/^\d+$/.test(req.amount)) fail("amount is not an integer");
  const amount = BigInt(req.amount);
  if (amount > lim.maxPackMicros) fail(`price ${amount} is above our cap ${lim.maxPackMicros}`);
  if (d.pricePerCall * d.maxCalls !== amount) fail(`price per call × calls (${d.pricePerCall} × ${d.maxCalls}) is not the amount ${amount}`);
  if (expect) {
    if (d.maxCalls !== BigInt(expect.calls)) fail(`the lock is for ${d.maxCalls} calls, not the ${expect.calls} calls of the chosen pack`);
    if (amount !== expect.priceMicros) fail(`the lock asks ${amount}, not the chosen pack's price ${expect.priceMicros}`);
    if (`sha256:${d.ruleHash}` !== expect.ruleHash) fail(`the datum's promise sha256:${d.ruleHash} is not the offered promise ${expect.ruleHash}`);
  }
  if (d.feeBps > (lim.maxFeeBps ?? MAX_FEE_BPS)) fail(`fee ${d.feeBps} bps is above ${lim.maxFeeBps ?? MAX_FEE_BPS}`);
  if (d.contestPeriod < MIN_CONTEST_PERIOD_MS || d.contestPeriod > (lim.maxContestMs ?? MAX_CONTEST_PERIOD_MS)) fail(`contest period ${d.contestPeriod} ms is out of range`);
  if (d.closeFeeBudget > MAX_CLOSE_FEE_BUDGET) fail(`close fee budget ${d.closeFeeBudget} is above ${MAX_CLOSE_FEE_BUDGET}`);
  if (typeof extra.channelId === "string" && extra.channelId !== d.channelId) fail("extra.channelId differs from the datum");
  try { validateDatumForLock(d, { priceMicros: amount }); } catch (e) { fail((e as Error).message); }
  return d;
}

/**
 * How a 402 offer settles. A hybrid gateway says so in `extra.settlement.mode`; anything but "direct" (including
 * no word at all, a PACK_MODE=escrow gateway) is held to the full escrow check.
 */
export function offerMode(req: Requirement): "direct" | "escrow" {
  return (req.extra?.settlement as { mode?: unknown } | undefined)?.mode === "direct" ? "direct" : "escrow";
}

/** The plain reasons a hybrid gateway gave, for logs. */
export function offerReasons(req: Requirement): string[] {
  const r = (req.extra?.settlement as { reasons?: unknown } | undefined)?.reasons;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/**
 * A direct offer from a hybrid gateway: exactly the chosen pack's price, a plain tUSDM transfer (not to the
 * escrow), and no more than our direct cap. Above the cap we only pay in escrow, where unused calls refund.
 */
export function checkDirectOffer(req: Requirement, expect: { priceMicros: bigint }, maxDirectMicros = DEFAULT_MAX_DIRECT_MICROS): void {
  directPackCheck({ amount: expect.priceMicros })(req);
  if (req.payTo === PACK_ESCROW.address) throw new EscrowOfferError("refusing to pay: a direct pack must not pay the escrow address");
  if (BigInt(req.amount) > maxDirectMicros) {
    throw new EscrowOfferError(`refusing to pay: ${formatMicros(req.amount)} tUSDM direct is above our direct cap of ${formatMicros(maxDirectMicros)} tUSDM`);
  }
}

// ---------------------------------------------------------------- the IOU key store

export type EscrowChannel = {
  apiId: string; packId: string; channelId: string | null; secretKey: string; publicKey: string; refundAddress: string;
  token: string | null; ruleHash: string | null;
  /** Passes we checked ourselves against the published rule. We never sign above this. */
  verifiedPasses: number;
  lastSigned: number;
  lastIou: string | null;
  disputed: boolean;
  createdAt: string;
  /**
   * A signed lock payment whose purchase answer we never got (e.g. HTTP 500 after settling). Presenting it to
   * `${buyUrl}/recover` with the recovery secret re-issues the token.
   */
  pendingPayment?: { paymentSignature: string; recoverySecret: string; buyUrl: string; at: string } | null;
  /** The gateway says it never opened this channel: nothing more to do through it. */
  abandoned?: boolean;
  /** The gateway accepted a close for this channel (it now settles on-chain): it no longer blocks a new purchase. */
  closeRequested?: boolean;
  /** A hybrid gateway settled this pack direct: a plain credit token, no channel, nothing to sign or close. */
  direct?: boolean;
};

/**
 * IOU secret keys live here: one JSON file, mode 0600 (git-ignored). The current key for a pack is at
 * `${apiId}/${packId}`; once that key is bound to a channel and a new pack is bought, the old record moves to
 * `${apiId}/${packId}#${channelId}` and is kept (it may still need closing).
 */
export class IouKeyStore {
  constructor(private readonly path: string) {}
  private all(): Record<string, EscrowChannel> {
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, EscrowChannel>; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
  private write(all: Record<string, EscrowChannel>) { writePrivateJson(this.path, all); }
  /** Where this record lives: the slot holding the same IOU key, else the pack's current slot. */
  private keyOf(all: Record<string, EscrowChannel>, c: EscrowChannel): string {
    const slot = `${c.apiId}/${c.packId}`;
    if (all[slot]?.publicKey === c.publicKey) return slot;
    return Object.keys(all).find((k) => all[k]!.apiId === c.apiId && all[k]!.publicKey === c.publicKey) ?? slot;
  }
  get(apiId: string, packId: string): EscrowChannel | undefined { return this.all()[`${apiId}/${packId}`]; }
  /** Every record for this API, archived ones included. */
  list(apiId: string): EscrowChannel[] { return Object.values(this.all()).filter((c) => c.apiId === apiId); }
  put(c: EscrowChannel): void { const a = this.all(); a[this.keyOf(a, c)] = c; this.write(a); }
  delete(apiId: string, packId: string): void { const a = this.all(); delete a[`${apiId}/${packId}`]; this.write(a); }

  /**
   * An unused IOU key for buying this pack. The stored key is reused only while it was never bound to a
   * channel; otherwise its record is archived (never overwritten: it may still need closing) and a fresh key
   * takes the pack's slot.
   */
  ensure(apiId: string, packId: string, refundAddress: string, now: Date): EscrowChannel {
    const a = this.all();
    const slot = `${apiId}/${packId}`;
    const have = a[slot];
    if (have && have.refundAddress === refundAddress && !have.channelId && !have.token && !have.disputed) return have;
    if (have?.channelId) a[`${slot}#${have.channelId}`] = have;
    else if (have?.token || have?.pendingPayment) a[`${slot}#direct-${have.createdAt}`] = have;
    const k = newReceiptKey();
    const c: EscrowChannel = {
      apiId, packId, channelId: null, secretKey: k.secretKey, publicKey: k.publicKey, refundAddress, token: null, ruleHash: null,
      verifiedPasses: 0, lastSigned: 0, lastIou: null, disputed: false, createdAt: now.toISOString(),
    };
    a[slot] = c;
    this.write(a);
    return c;
  }
}

// ---------------------------------------------------------------- signing

/** Signs IOU n only when n ≤ the passes we verified ourselves. Returns the header value, or null when we won't. */
export function signNext(c: EscrowChannel, n: number): string | null {
  if (!c.channelId || c.disputed || !Number.isSafeInteger(n) || n < 1 || n > c.verifiedPasses) return null;
  if (n <= c.lastSigned && c.lastIou) return c.lastIou;
  const iou = `${n}.${signReceipt(c.secretKey, c.channelId, n)}`;
  c.lastSigned = n;
  c.lastIou = iou;
  return iou;
}

export type RuleFetch = (ruleHash: string) => Promise<RuleDefinition>;

export type EscrowCallResult =
  | { kind: "pass"; body: unknown; contentType: string | null; signed: number | null }
  | { kind: "dispute"; reasons: string[] }
  | { kind: "not_met" | "upstream_error" | "down"; status: number; body: unknown }
  | { kind: "iou_required"; signNext: number }
  | { kind: "closing" | "pending" | "rejected"; status: number; body: unknown };

/**
 * One paid call. Sends the latest IOU; on 200 re-checks the answer against the rule and, only if it passes
 * locally, counts it and signs the gateway's Sign-Next. On 402 iou_required signs (if earned) and retries once.
 * A gateway "pass" that fails our check is a dispute: nothing is signed and the caller should close.
 */
export async function escrowCall(
  deps: { fetch: FetchLike; rule: RuleFetch; save: (c: EscrowChannel) => void },
  c: EscrowChannel,
  url: string,
  retried = false,
): Promise<EscrowCallResult> {
  if (!c.token) throw new Error("no token for this channel");
  const headers: Record<string, string> = { accept: ANSWER_ACCEPT, authorization: `Bearer ${c.token}` };
  if (c.lastIou) headers["x-hirakumi-iou"] = c.lastIou;
  const res = await deps.fetch(url, { method: "GET", headers });
  const text = await res.text();
  const contentType = res.headers.get("content-type");
  if (res.status === 200) {
    if (!c.ruleHash) throw new Error("channel has no rule hash");
    const verdict = compileRule(await deps.rule(c.ruleHash)).check({ status: 200, contentType, body: text, latencyMs: 0 });
    if (!verdict.pass) {
      c.disputed = true;
      deps.save(c);
      return { kind: "dispute", reasons: verdict.reasons };
    }
    c.verifiedPasses += 1;
    const n = Number(res.headers.get("x-hirakumi-sign-next"));
    const iou = signNext(c, n);
    deps.save(c);
    return { kind: "pass", body: answerBody(text, contentType), contentType, signed: iou ? n : null };
  }
  // Refusals come from the gateway itself, always JSON.
  const body = safeJson(text);
  const err = (body as { error?: unknown } | undefined)?.error;
  if (res.status === 402 && err === "iou_required") {
    const n = Number((body as { signNext?: unknown }).signNext);
    if (!retried && signNext(c, n)) {
      deps.save(c);
      return escrowCall(deps, c, url, true);
    }
    return { kind: "iou_required", signNext: n };
  }
  if (res.status === 422) return { kind: "not_met", status: 422, body };
  if (res.status === 502 || res.status === 504) return { kind: "upstream_error", status: res.status, body };
  if (res.status === 503) return { kind: "down", status: 503, body };
  if (res.status === 409) return { kind: "closing", status: 409, body };
  if (res.status === 401 && err === "token_pending") return { kind: "pending", status: 401, body };
  return { kind: "rejected", status: res.status, body };
}

/**
 * Asks the gateway to close with our latest IOU. With a token it authenticates with the bearer; without one
 * (e.g. the purchase answer was lost) it proves the channel is ours with a close-request signature by the
 * channel's IOU key (`x-hirakumi-close-auth`, "HKC1" ‖ channel id: never valid as an on-chain IOU).
 */
export async function requestEscrowClose(fetchImpl: FetchLike, gatewayUrl: string, c: EscrowChannel): Promise<{ status: number; body: unknown }> {
  if (!c.channelId) throw new Error("this pack has no channel yet");
  const url = new URL(`/a/${encodeURIComponent(c.apiId)}/channels/${c.channelId}/close`, gatewayUrl).toString();
  const headers: Record<string, string> = { accept: "application/json" };
  if (c.token) headers.authorization = `Bearer ${c.token}`;
  else headers["x-hirakumi-close-auth"] = signCloseRequest(c.secretKey, c.channelId);
  if (c.lastIou) headers["x-hirakumi-iou"] = c.lastIou;
  const res = await fetchImpl(url, { method: "POST", headers });
  return { status: res.status, body: safeJson(await res.text()) };
}
