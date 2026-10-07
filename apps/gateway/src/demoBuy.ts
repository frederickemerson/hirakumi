import type { RequestHandler, Response } from "express";
import {
  checkDirectOffer, checkEscrowOffer, choosePack, createPackPayer, fetchWalletBalance, formatMicros, NoAffordablePackError, PackPurchaseError,
  offerMode, offerReasons, parseCreditsRequired, PaymentNotSentError, recoverPack, type PackOffer,
} from "@hirakumi/buyer";
import { newReceiptKey } from "@hirakumi/escrow";
import { newId } from "@hirakumi/core";
import {
  expireStaleTryPurchases, findTryPurchase, findUnsettledTryPurchase, findUsableTryPack, markTryActive, markTryEnded, markTryUnsettled,
  reserveTryPurchase, saveTryChannel, saveTrySignature, withTryApiLock, type TryPurchaseLimits, type TryScope, type UsableTryPack,
} from "@hirakumi/db";
import type { AppDeps, DemoBuyer } from "./deps";
import { creditsRequiredBody } from "./http";
import { primaryRule } from "./registry";

/** Hard limits on live purchases from the demo wallet. Enforced here, in the database, across instances. */
export const TRY_LIMITS: TryPurchaseLimits = { perApiWindowSeconds: 10 * 60, globalPerHour: 6, globalPerDay: 24, freeTestsPerSeller: 3 };
/** Never pay more than this for one pack (5 tUSDM). Also the buyer library's spend cap. */
export const MAX_PACK_MICROS = 5_000_000n;
/** Below this the wallet can't be trusted to cover fees and the min-ADA of the payment output. */
export const MIN_LOVELACE = 3_000_000n;
/** A purchase still `buying` after this crashed (the web gives up after 110 s). */
export const BUYING_STALE_MINUTES = 10;
/** /recover is our own gateway; past this the lock is released and the next try asks again. */
const RECOVER_TIMEOUT_MS = 20_000;

/**
 * One line of the NDJSON progress stream: paying, settling (the payment is signed and sent), then one outcome.
 * settled and failed are final. pending is not: the payment may have left and Cardano has not confirmed it yet,
 * so the caller asks again with ?resume=<purchaseId> until it is settled or failed. failed is sent only when that
 * is certain (never signed, or Hirakumi never received it). `ready` = an existing pack is reused.
 */
export type BuyEvent =
  | { phase: "paying"; purchaseId: string; packId: string; calls: number; priceMicros: string; wallet: string; escrow: boolean }
  | { phase: "settling"; settlement?: { mode: "direct" | "escrow"; reasons: string[] } }
  | { phase: "settled"; txHash: string | null; credits: number; ms: number; recovered: boolean }
  | { phase: "ready"; txHash: string | null; credits: number; pending: boolean; boughtAt: string }
  | { phase: "pending"; purchaseId: string; message: string }
  | { phase: "failed"; message: string; spent: boolean };

export const PENDING_MESSAGE = "The payment is sent and waiting for Cardano to confirm it. It is saved, so it is never paid twice.";
export const NOT_PAID_MESSAGE = "The payment did not go through. Nothing was paid.";
const NOT_RECEIVED_MESSAGE = "Hirakumi never received the payment, so nothing was paid.";
const NOT_STARTED_MESSAGE = "No purchase was started, so nothing was paid.";
const ENDED_MESSAGE = "The purchase did not complete.";
/** ?resume=<purchaseId> asks for that purchase; ?resume=latest for the newest one within this many minutes. */
const RESUME_WINDOW_MINUTES = 2 * 10;
const PURCHASE_ID = /^try_[A-Za-z0-9_-]{1,64}$/;

function refuse(res: Response, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error, message, ...extra });
}

function minutes(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

function stream(res: Response): (e: BuyEvent) => void {
  res.status(200).set({ "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.flushHeaders();
  // The purchase carries on if the caller goes away: its result is stored either way.
  return (e) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`); };
}

type Refusal = { status: number; error: string; message: string; extra?: Record<string, unknown>; retryAfter?: number };
type Plan =
  | { kind: "ready"; pack: UsableTryPack }
  | { kind: "recovered"; credits: number; txHash: string | null; recovered: boolean }
  | { kind: "pending"; id: string }
  | { kind: "failed"; spent: boolean; message: string }
  | { kind: "refuse"; refusal: Refusal }
  | { kind: "reserved"; id: string; pack: PackOffer; ruleHash: string };

/** The transaction withTryApiLock runs its step in. */
type Tx = Parameters<Parameters<typeof withTryApiLock>[2]>[0];
type Unsettled = { id: string; packId: string; paymentSignature: string; recoverySecret: string };

/**
 * Asks /recover for a signed payment whose answer was lost. recovered: the row is active. pending: not
 * confirmed yet. not_received / refused: final, the row is ended.
 */
async function recoverUnsettled(
  d: AppDeps, tx: Tx, buyer: DemoBuyer, apiId: string, u: Unsettled,
): Promise<{ kind: "recovered"; credits: number } | { kind: "pending" } | { kind: "not_received" | "refused" }> {
  const timedFetch = (url: string, init?: RequestInit) => buyer.fetch(url, { ...init, signal: AbortSignal.timeout(RECOVER_TIMEOUT_MS) });
  let r: Awaited<ReturnType<typeof recoverPack>>;
  try {
    r = await recoverPack(timedFetch, d.config.publicBaseUrl, apiId, u);
  } catch {
    return { kind: "pending" }; // /recover did not answer: nothing is known yet
  }
  if (r.kind === "recovered") {
    // A DB error here rolls back and leaves the row unsettled: the next ask re-keys it again.
    await markTryActive(tx, u.id, "unsettled", { token: r.token, txHash: null, credits: r.credits });
    return { kind: "recovered", credits: r.credits };
  }
  if (r.kind === "failed") return { kind: "pending" };
  // 404: never received, nothing paid. 403: final. Either way that attempt is over.
  await markTryEnded(tx, u.id, "unsettled", r.kind === "not_received" ? "void" : "failed", `recovery: ${r.kind}`);
  return { kind: r.kind };
}

/** Where one purchase stands, for ?resume. Never buys. */
type Outcome = Exclude<Plan, { kind: "reserved" }>;

async function resumePlan(d: AppDeps, tx: Tx, buyer: DemoBuyer, apiId: string, scope: TryScope, id: string | null): Promise<Outcome> {
  await expireStaleTryPurchases(tx, apiId, BUYING_STALE_MINUTES);
  const p = await findTryPurchase(tx, apiId, scope, id, RESUME_WINDOW_MINUTES);
  if (!p) return { kind: "failed", spent: false, message: NOT_STARTED_MESSAGE };
  switch (p.status) {
    case "buying": return { kind: "pending", id: p.id };
    case "active": return { kind: "recovered", credits: p.credits ?? 0, txHash: p.txHash, recovered: false };
    case "void": return { kind: "failed", spent: false, message: NOT_PAID_MESSAGE };
    case "failed": return { kind: "failed", spent: true, message: ENDED_MESSAGE };
    case "unsettled": {
      if (!p.packId || !p.paymentSignature || !p.recoverySecret) return { kind: "pending", id: p.id };
      const r = await recoverUnsettled(d, tx, buyer, apiId, { id: p.id, packId: p.packId, paymentSignature: p.paymentSignature, recoverySecret: p.recoverySecret });
      if (r.kind === "recovered") return { kind: "recovered", credits: r.credits, txHash: p.txHash, recovered: true };
      if (r.kind === "pending") return { kind: "pending", id: p.id };
      return r.kind === "not_received"
        ? { kind: "failed", spent: false, message: NOT_RECEIVED_MESSAGE }
        : { kind: "failed", spent: true, message: ENDED_MESSAGE };
    }
  }
}

/**
 * POST /internal/demo/buy-pack/:apiId: a real x402 pack purchase on Cardano preprod from Hirakumi's demo
 * buyer wallet, through the gateway's own public URL, exactly as an outside agent buys. The token is stored
 * in try_tokens for the web's "Try it live". Only featured APIs (TRY_LIVE_APIS) are bought for: the payment
 * goes to the seller, so an open endpoint would let anyone list an API and drain the demo wallet.
 * PACK_MODE=escrow: the pack is locked at pack_escrow like any agent's, with a fresh IOU key kept on the row;
 * the web signs an IOU for each answer it checked against the promise, and the rest refunds to the wallet.
 * PACK_MODE=hybrid: the wallet asks like any agent with escrow headers and follows the 402's settlement: escrow
 * as above, or direct (the key is then unused). The `settling` event says which, and why.
 * Order, under one per-API lock: reuse a pack with credits, recover an unsettled payment, price cap, limits.
 * Then, outside the lock: wallet funds and the payment.
 * ?resume=<purchaseId> (or latest) never buys: it streams where that purchase stands (resumePlan).
 */
export function demoBuyPack(d: AppDeps, kind: "showcase" | "self_test" = "showcase"): RequestHandler {
  return async (req, res, next) => {
    try {
      const apiId = req.params.apiId;
      const resumeParam = typeof req.query.resume === "string" ? req.query.resume : null;
      if (resumeParam !== null && resumeParam !== "latest" && !PURCHASE_ID.test(resumeParam)) {
        refuse(res, 400, "bad_resume", "resume must be a purchase id or latest."); return;
      }
      if (kind === "showcase" && !d.config.tryLiveApis.includes(apiId)) {
        refuse(res, 403, "not_featured", "Live purchases are funded by Hirakumi's demo wallet, so they're on featured APIs only.");
        return;
      }
      const loaded = await d.registry.get(apiId, { fresh: true });
      // A payment already in flight is followed to its outcome whatever the API's state is now.
      if (!loaded || (resumeParam === null && loaded.api.state !== "live")) { refuse(res, 404, "api_not_found", "This API is not live."); return; }
      // A free self test is bought for the API's own seller; the web checked that the caller is that seller.
      const scope: TryScope = { selfTestSellerId: kind === "self_test" ? loaded.api.seller_id : null };
      if (resumeParam === null && d.health.get(loaded.api.id)?.health === "down") {
        refuse(res, 503, "api_down", "This API is Down right now, so nothing is bought."); return;
      }
      const buyer = d.demoBuyer;
      if (!buyer) { refuse(res, 503, "buyer_not_configured", "The demo wallet is not set up on this gateway."); return; }

      if (resumeParam !== null) {
        const resumeId = resumeParam === "latest" ? null : resumeParam;
        const plan = await withTryApiLock<Outcome>(d.sql, apiId, (tx) => resumePlan(d, tx, buyer, apiId, scope, resumeId));
        sendOutcome(res, plan);
        return;
      }

      const plan = await withTryApiLock<Plan>(d.sql, apiId, async (tx) => {
        await expireStaleTryPurchases(tx, apiId, BUYING_STALE_MINUTES);
        const usable = await findUsableTryPack(tx, apiId, scope);
        if (usable) return { kind: "ready", pack: usable };

        const unsettled = await findUnsettledTryPurchase(tx, apiId, scope);
        if (unsettled) {
          const r = await recoverUnsettled(d, tx, buyer, apiId, unsettled);
          if (r.kind === "recovered") {
            const pack = await findUsableTryPack(tx, apiId, scope);
            return { kind: "recovered", credits: r.credits, txHash: pack?.txHash ?? null, recovered: true };
          }
          // An earlier payment is still settling: follow it, never pay a second time.
          if (r.kind === "pending") return { kind: "pending", id: unsettled.id };
          // not_received / refused: that attempt is over, so a new one may start.
        }

        const rule = primaryRule(loaded);
        if (!rule) return { kind: "refuse", refusal: { status: 503, error: "promise_not_published", message: "This API has no published promise yet." } };
        // The same 402 offer an agent reads, chosen with the buyer library's own rule and cap.
        const offer = parseCreditsRequired(creditsRequiredBody(d.config, loaded, rule), d.config.publicBaseUrl);
        let pack: PackOffer;
        try {
          pack = choosePack(offer, MAX_PACK_MICROS);
        } catch (e) {
          if (e instanceof NoAffordablePackError) {
            return { kind: "refuse", refusal: { status: 409, error: "price_over_cap", message: `A pack for this API costs more than ${formatMicros(MAX_PACK_MICROS)} tUSDM, the live demo's cap.` } };
          }
          throw e;
        }
        const id = newId("try");
        const slot = await reserveTryPurchase(tx, { id, apiId, packId: pack.packId, priceMicros: pack.price, limits: TRY_LIMITS, scope });
        if (!slot.ok && (slot.reason === "free_test_used" || slot.reason === "free_test_seller_cap")) {
          const message = slot.reason === "free_test_used"
            ? "You already used the free test for this API. Pay with your own wallet to test again."
            : `You used all ${TRY_LIMITS.freeTestsPerSeller} free tests on your account. Pay with your own wallet to test again.`;
          return { kind: "refuse", refusal: { status: 409, error: slot.reason, message } };
        }
        if (!slot.ok) {
          const wait = slot.retryAfterSeconds ?? 60;
          const message = slot.reason === "api_cooldown"
            ? `This API had a live purchase in the last 10 minutes. Try again in ${minutes(wait)}.`
            : slot.reason === "global_hourly"
              ? `The live demo made ${TRY_LIMITS.globalPerHour} purchases this hour. Try again in ${minutes(wait)}.`
              : `The live demo made ${TRY_LIMITS.globalPerDay} purchases today. Try again in ${minutes(wait)}.`;
          return {
            kind: "refuse",
            refusal: { status: 429, error: slot.reason, message, extra: { retryAfterSeconds: wait }, retryAfter: wait },
          };
        }
        return { kind: "reserved", id, pack, ruleHash: offer.ruleHash };
      });

      if (plan.kind === "reserved") {
        await pay(d, res, buyer, apiId, plan.id, plan.pack, plan.ruleHash);
        return;
      }
      sendOutcome(res, plan);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      next(e);
    }
  };
}

/** Any plan but a new payment: one outcome event, or a refusal. */
function sendOutcome(res: Response, plan: Outcome): void {
  if (plan.kind === "refuse") {
    if (plan.refusal.retryAfter !== undefined) res.set("retry-after", String(plan.refusal.retryAfter));
    refuse(res, plan.refusal.status, plan.refusal.error, plan.refusal.message, plan.refusal.extra);
    return;
  }
  const send = stream(res);
  if (plan.kind === "ready") {
    send({ phase: "ready", txHash: plan.pack.txHash, credits: plan.pack.remaining, pending: plan.pack.pending, boughtAt: plan.pack.boughtAt.toISOString() });
  } else if (plan.kind === "recovered") {
    send({ phase: "settled", txHash: plan.txHash, credits: plan.credits, ms: 0, recovered: plan.recovered });
  } else if (plan.kind === "pending") {
    send({ phase: "pending", purchaseId: plan.id, message: PENDING_MESSAGE });
  } else {
    send({ phase: "failed", spent: plan.spent, message: plan.message });
  }
  res.end();
}

async function pay(d: AppDeps, res: Response, buyer: DemoBuyer, apiId: string, id: string, pack: PackOffer, ruleHash: string): Promise<void> {
  let funds: { lovelace: bigint; usdmMicros: bigint };
  try {
    funds = await buyer.balance();
  } catch (e) {
    await markTryEnded(d.sql, id, "buying", "void", `balance: ${(e as Error).message}`);
    refuse(res, 503, "balance_unavailable", "Couldn't read the demo wallet's balance. Try again in a minute.");
    return;
  }
  if (funds.lovelace < MIN_LOVELACE) {
    await markTryEnded(d.sql, id, "buying", "void", "low tADA");
    refuse(res, 409, "low_funds",
      `The demo wallet has ${formatMicros(funds.lovelace)} tADA. It needs at least ${formatMicros(MIN_LOVELACE)} tADA for fees, so nothing was bought.`);
    return;
  }
  if (funds.usdmMicros < BigInt(pack.price)) {
    await markTryEnded(d.sql, id, "buying", "void", "low tUSDM");
    refuse(res, 409, "low_funds",
      `The demo wallet has ${formatMicros(funds.usdmMicros)} tUSDM and the pack costs ${formatMicros(pack.price)}, so nothing was bought.`);
    return;
  }

  const send = stream(res);
  const started = Date.now();
  // What /recover needs, saved on the row before the payment is sent (see SignedHook).
  let saved: { paymentSignature: string; recoverySecret: string } | null = null;
  send({ phase: "paying", purchaseId: id, packId: pack.packId, calls: pack.calls, priceMicros: pack.price, wallet: buyer.address, escrow: d.config.packMode === "escrow" });
  // Hybrid: what the 402 said, once our check accepted it (set before onSigned).
  let settlement: { mode: "direct" | "escrow"; reasons: string[] } | null = null;
  const onSigned = async (s: { paymentSignature: string; recoverySecret: string }) => {
    saved = s;
    send(d.config.packMode === "hybrid" && settlement ? { phase: "settling", settlement } : { phase: "settling" });
    try {
      await saveTrySignature(d.sql, id, s);
    } catch (e) {
      console.error(`[demo-buy] ${apiId}: saving the signed payment failed: ${(e as Error).message}`);
    }
  };
  let purchase: { token: string; credits: number; txHash: string | null };
  try {
    purchase = escrowPacks(d)
      ? await buyEscrow(d, buyer, apiId, id, pack, ruleHash, onSigned, (x) => { settlement = x; })
      : await buyer.buyPack(pack.buyUrl, { amount: BigInt(pack.price) }, { onSigned });
  } catch (e) {
    const detail = (e as Error)?.message ?? String(e);
    const keep = e instanceof PaymentNotSentError ? null : e instanceof PackPurchaseError && e.paymentSignature && e.recoverySecret
      ? { paymentSignature: e.paymentSignature, recoverySecret: e.recoverySecret }
      : saved;
    if (keep) {
      await markTryUnsettled(d.sql, id, { ...keep, error: detail });
      send({ phase: "pending", purchaseId: id, message: PENDING_MESSAGE });
    } else {
      // Never signed (or refused before it was sent): certain that nothing was paid.
      await markTryEnded(d.sql, id, "buying", "void", detail);
      send({ phase: "failed", spent: false, message: NOT_PAID_MESSAGE });
    }
    console.error(`[demo-buy] ${apiId}: ${detail}`);
    res.end();
    return;
  }

  // The money has moved. A DB error from here on must not lose the token: keep the attempt recoverable.
  try {
    await markTryActive(d.sql, id, "buying", purchase);
    send({ phase: "settled", txHash: purchase.txHash, credits: purchase.credits, ms: Date.now() - started, recovered: false });
  } catch (e) {
    const detail = `paid, but saving the pack failed: ${(e as Error)?.message ?? String(e)}`;
    console.error(`[demo-buy] ${apiId}: ${detail}`);
    if (saved) {
      // If this write fails too, the row stays `buying` with its saved payment and expires to `unsettled`.
      await markTryUnsettled(d.sql, id, { ...(saved as { paymentSignature: string; recoverySecret: string }), error: detail })
        .catch((e2: unknown) => console.error(`[demo-buy] ${apiId}: ${(e2 as Error).message}`));
    }
    // The money moved; only our record of it is missing, and ?resume recovers it.
    send({ phase: "pending", purchaseId: id, message: PENDING_MESSAGE });
  }
  res.end();
}

/** Escrow and hybrid buy with escrow headers; hybrid may still settle direct. */
const escrowPacks = (d: AppDeps) => d.config.packMode !== "direct";

/**
 * An escrow pack, bought the way the buyer agent buys one: a fresh IOU key, the 402's datum checked (our key,
 * our refund address, the chosen pack's calls, price and promise) before anything is signed, and the channel
 * and key saved on the row before the lock is sent, so a lock that lands can always be signed for and closed.
 * A hybrid gateway may answer direct instead: then the plain pack check runs (exact price, under the cap) and
 * nothing is saved but the payment.
 */
async function buyEscrow(
  d: AppDeps, buyer: DemoBuyer, apiId: string, id: string, pack: PackOffer, ruleHash: string,
  onSigned: (s: { paymentSignature: string; recoverySecret: string }) => Promise<void>,
  onSettlement: (s: { mode: "direct" | "escrow"; reasons: string[] }) => void,
): Promise<{ token: string; credits: number; txHash: string | null }> {
  const key = newReceiptKey();
  const keys = { receiptKey: key.publicKey, refundAddress: buyer.address };
  let checked: { channelId: string; ruleHash: string } | null = null;
  let approved: "direct" | "escrow" | null = null;
  const p = await buyer.buyEscrowPack(pack.buyUrl, keys, (req) => {
    checked = null;
    approved = null;
    if (offerMode(req) === "direct") {
      checkDirectOffer(req, { priceMicros: BigInt(pack.price) }, MAX_PACK_MICROS);
      approved = "direct";
      onSettlement({ mode: "direct", reasons: offerReasons(req) });
      return;
    }
    const datum = checkEscrowOffer(req, { ...keys, maxPackMicros: MAX_PACK_MICROS }, {
      calls: pack.calls, priceMicros: BigInt(pack.price), ruleHash,
    });
    checked = { channelId: datum.channelId, ruleHash: `sha256:${datum.ruleHash}` };
    approved = "escrow";
    onSettlement({ mode: "escrow", reasons: offerReasons(req) });
  }, {
    onSigned: async (s) => {
      if (approved === "escrow" && checked) {
        await saveTryChannel(d.sql, id, { ...checked, iouSecret: key.secretKey }).catch((e: unknown) =>
          console.error(`[demo-buy] ${apiId}: saving the escrow channel failed: ${(e as Error).message}`));
      }
      await onSigned(s);
    },
  });
  if ((approved as "direct" | "escrow" | null) === "direct") return { token: p.token, credits: p.credits, txHash: p.txHash };
  const c = checked as { channelId: string } | null;
  if (!c || p.channelId !== c.channelId) {
    // Our IOUs may only ever be bound to the datum's channel: a different answer is never used.
    throw new PackPurchaseError(200, `the gateway answered channel ${p.channelId}, not the locked ${c?.channelId ?? "(unchecked)"}`);
  }
  return { token: p.token, credits: p.credits, txHash: p.txHash };
}

/** The demo buyer from BUYER_MNEMONIC + BLOCKFROST_PROJECT_ID, or null when either is missing. */
export function demoBuyerFromEnv(env: NodeJS.ProcessEnv): DemoBuyer | null {
  const mnemonic = env.BUYER_MNEMONIC?.trim();
  const projectId = env.BLOCKFROST_PROJECT_ID?.trim();
  if (!mnemonic || !projectId) return null;
  const blockfrost = { baseUrl: env.BLOCKFROST_BASE_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0", projectId };
  const payer = createPackPayer({ mnemonic, blockfrostProjectId: projectId, blockfrostBaseUrl: blockfrost.baseUrl, maxPackMicros: MAX_PACK_MICROS });
  const doFetch = (input: string, init?: RequestInit) => globalThis.fetch(input, init);
  return {
    address: payer.address,
    buyPack: (url, expected, hooks) => payer.buyPack(url, expected, hooks),
    buyEscrowPack: (url, keys, check, hooks) => payer.buyEscrowPack(url, keys, check, hooks),
    balance: () => fetchWalletBalance(doFetch, blockfrost, payer.address),
    fetch: doFetch,
  };
}
