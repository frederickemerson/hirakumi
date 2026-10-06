// Escrow packs, buyer side: check the 402 datum before paying, keep the IOU key, re-check every passing
// answer against the published promise locally, and sign an IOU only for passes we verified ourselves.
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { compileRule, type RuleDefinition } from "@hirakumi/core";
import {
  MAX_CLOSE_FEE_BUDGET, MAX_CONTEST_PERIOD_MS, MIN_CONTEST_PERIOD_MS, PACK_ESCROW, decodePackDatum, newReceiptKey, signReceipt,
  validateDatumForLock, type PackDatum,
} from "@hirakumi/escrow";
import { safeJson, type FetchLike } from "./gatewayClient.js";

export const MAX_FEE_BPS = 1000n;

export class EscrowOfferError extends Error {}

/** The parts of an x402 PaymentRequirements the check reads. */
export type Requirement = { scheme: string; network: string; asset: string; amount: string; payTo: string; extra?: Record<string, unknown> };

export type OfferLimits = { receiptKey: string; refundAddress: string; maxPackMicros: bigint; maxFeeBps?: bigint; maxContestMs?: bigint };

/**
 * Refuses to pay unless the lock would be exactly what we expect: the known escrow script and address, our
 * IOU key and refund address in the datum, price = per-call × calls = amount, a sane fee, contest period
 * and close-fee budget. A malicious gateway can't redirect the refund or change the terms.
 */
export function checkEscrowOffer(req: Requirement, lim: OfferLimits): PackDatum {
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
  if (d.receiptKey !== lim.receiptKey.toLowerCase()) fail("the datum's receipt key is not ours");
  if (d.buyerRefund !== lim.refundAddress) fail(`the datum refunds ${d.buyerRefund}, not our address`);
  if (`${d.policyId}.${d.assetName}` !== USDM_PREPROD_ASSET) fail("the datum's asset is not the paid asset");
  if (!/^\d+$/.test(req.amount)) fail("amount is not an integer");
  const amount = BigInt(req.amount);
  if (amount > lim.maxPackMicros) fail(`price ${amount} is above our cap ${lim.maxPackMicros}`);
  if (d.pricePerCall * d.maxCalls !== amount) fail(`price per call × calls (${d.pricePerCall} × ${d.maxCalls}) is not the amount ${amount}`);
  if (d.feeBps > (lim.maxFeeBps ?? MAX_FEE_BPS)) fail(`fee ${d.feeBps} bps is above ${lim.maxFeeBps ?? MAX_FEE_BPS}`);
  if (d.contestPeriod < MIN_CONTEST_PERIOD_MS || d.contestPeriod > (lim.maxContestMs ?? MAX_CONTEST_PERIOD_MS)) fail(`contest period ${d.contestPeriod} ms is out of range`);
  if (d.closeFeeBudget > MAX_CLOSE_FEE_BUDGET) fail(`close fee budget ${d.closeFeeBudget} is above ${MAX_CLOSE_FEE_BUDGET}`);
  if (typeof extra.channelId === "string" && extra.channelId !== d.channelId) fail("extra.channelId differs from the datum");
  try { validateDatumForLock(d, { priceMicros: amount }); } catch (e) { fail((e as Error).message); }
  return d;
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
};

/** IOU secret keys live here: one JSON file, mode 0600, keyed by `${apiId}/${packId}` (git-ignored). */
export class IouKeyStore {
  constructor(private readonly path: string) {}
  private all(): Record<string, EscrowChannel> {
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, EscrowChannel>; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
  private write(all: Record<string, EscrowChannel>) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
  get(apiId: string, packId: string): EscrowChannel | undefined { return this.all()[`${apiId}/${packId}`]; }
  list(apiId: string): EscrowChannel[] { return Object.values(this.all()).filter((c) => c.apiId === apiId); }
  put(c: EscrowChannel): void { const a = this.all(); a[`${c.apiId}/${c.packId}`] = c; this.write(a); }
  delete(apiId: string, packId: string): void { const a = this.all(); delete a[`${apiId}/${packId}`]; this.write(a); }

  /** The channel for this pack, creating a fresh IOU key if we have none (or the old one was used up). */
  ensure(apiId: string, packId: string, refundAddress: string, now: Date): EscrowChannel {
    const have = this.get(apiId, packId);
    if (have && have.refundAddress === refundAddress) return have;
    const k = newReceiptKey();
    const c: EscrowChannel = {
      apiId, packId, channelId: null, secretKey: k.secretKey, publicKey: k.publicKey, refundAddress, token: null, ruleHash: null,
      verifiedPasses: 0, lastSigned: 0, lastIou: null, disputed: false, createdAt: now.toISOString(),
    };
    this.put(c);
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
  | { kind: "pass"; body: unknown; signed: number | null }
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
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${c.token}` };
  if (c.lastIou) headers["x-hirakumi-iou"] = c.lastIou;
  const res = await deps.fetch(url, { method: "GET", headers });
  const text = await res.text();
  const body = safeJson(text);
  if (res.status === 200) {
    if (!c.ruleHash) throw new Error("channel has no rule hash");
    const verdict = compileRule(await deps.rule(c.ruleHash)).check({ status: 200, contentType: res.headers.get("content-type"), body: text, latencyMs: 0 });
    if (!verdict.pass) {
      c.disputed = true;
      deps.save(c);
      return { kind: "dispute", reasons: verdict.reasons };
    }
    c.verifiedPasses += 1;
    const n = Number(res.headers.get("x-hirakumi-sign-next"));
    const iou = signNext(c, n);
    deps.save(c);
    return { kind: "pass", body: body ?? text, signed: iou ? n : null };
  }
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

/** Asks the gateway to close with our latest IOU. */
export async function requestEscrowClose(fetchImpl: FetchLike, gatewayUrl: string, c: EscrowChannel): Promise<{ status: number; body: unknown }> {
  if (!c.channelId || !c.token) throw new Error("this pack has no channel yet");
  const url = new URL(`/a/${encodeURIComponent(c.apiId)}/channels/${c.channelId}/close`, gatewayUrl).toString();
  const headers: Record<string, string> = { authorization: `Bearer ${c.token}`, accept: "application/json" };
  if (c.lastIou) headers["x-hirakumi-iou"] = c.lastIou;
  const res = await fetchImpl(url, { method: "POST", headers });
  return { status: res.status, body: safeJson(await res.text()) };
}
