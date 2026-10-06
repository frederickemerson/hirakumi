import type { RequestHandler, Response } from "express";
import {
  checkEscrowOffer, choosePack, createPackPayer, fetchWalletBalance, formatMicros, NoAffordablePackError, PackPurchaseError,
  parseCreditsRequired, PaymentNotSentError, recoverPack, type PackOffer,
} from "@hirakumi/buyer";
import { newReceiptKey } from "@hirakumi/escrow";
import { newId } from "@hirakumi/core";
import {
  expireStaleTryPurchases, findUnsettledTryPurchase, findUsableTryPack, markTryActive, markTryEnded, markTryUnsettled,
  reserveTryPurchase, saveTryChannel, saveTrySignature, withTryApiLock, type TryPurchaseLimits, type UsableTryPack,
} from "@hirakumi/db";
import type { AppDeps, DemoBuyer } from "./deps";
import { creditsRequiredBody } from "./http";
import { primaryRule } from "./registry";

/** Hard limits on live purchases from the demo wallet. Enforced here, in the database, across instances. */
export const TRY_LIMITS: TryPurchaseLimits = { perApiWindowSeconds: 10 * 60, globalPerHour: 6, globalPerDay: 24 };
/** Never pay more than this for one pack (5 tUSDM). Also the buyer library's spend cap. */
export const MAX_PACK_MICROS = 5_000_000n;
/** Below this the wallet can't be trusted to cover fees and the min-ADA of the payment output. */
export const MIN_LOVELACE = 3_000_000n;
/** A purchase still `buying` after this crashed (the web gives up after 110 s). */
export const BUYING_STALE_MINUTES = 10;
/** /recover is our own gateway; past this the lock is released and the next try asks again. */
const RECOVER_TIMEOUT_MS = 20_000;

/**
 * One line of the NDJSON progress stream:
 * paying, settling (the payment is signed and sent), then settled or failed. `ready` = an existing pack is reused.
 */
export type BuyEvent =
  | { phase: "paying"; packId: string; calls: number; priceMicros: string; wallet: string; escrow: boolean }
  | { phase: "settling" }
  | { phase: "settled"; txHash: string | null; credits: number; ms: number; recovered: boolean }
  | { phase: "ready"; txHash: string | null; credits: number; pending: boolean; boughtAt: string }
  | { phase: "failed"; message: string; spent: boolean };

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
  | { kind: "recovered"; credits: number; txHash: string | null }
  | { kind: "refuse"; refusal: Refusal }
  | { kind: "reserved"; id: string; pack: PackOffer; ruleHash: string };

/**
 * POST /internal/demo/buy-pack/:apiId: a real x402 pack purchase on Cardano preprod from Hirakumi's demo
 * buyer wallet, through the gateway's own public URL, exactly as an outside agent buys. The token is stored
 * in try_tokens for the web's "Try it live". Only featured APIs (TRY_LIVE_APIS) are bought for: the payment
 * goes to the seller, so an open endpoint would let anyone list an API and drain the demo wallet.
 * PACK_MODE=escrow: the pack is locked at pack_escrow like any agent's, with a fresh IOU key kept on the row;
 * the web signs an IOU for each answer it checked against the promise, and the rest refunds to the wallet.
 * Order, under one per-API lock: reuse a pack with credits, recover an unsettled payment, price cap, limits.
 * Then, outside the lock: wallet funds and the payment.
 */
export function demoBuyPack(d: AppDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const apiId = req.params.apiId;
      if (!d.config.tryLiveApis.includes(apiId)) {
        refuse(res, 403, "not_featured", "Live purchases are funded by Hirakumi's demo wallet, so they're on featured APIs only.");
        return;
      }
      const loaded = await d.registry.get(apiId, { fresh: true });
      if (!loaded || loaded.api.state !== "live") { refuse(res, 404, "api_not_found", "This API is not live."); return; }
      if (d.health.get(loaded.api.id)?.health === "down") {
        refuse(res, 503, "api_down", "This API is Down right now, so nothing is bought."); return;
      }
      const buyer = d.demoBuyer;
      if (!buyer) { refuse(res, 503, "buyer_not_configured", "The demo wallet is not set up on this gateway."); return; }

      const plan = await withTryApiLock<Plan>(d.sql, apiId, async (tx) => {
        await expireStaleTryPurchases(tx, apiId, BUYING_STALE_MINUTES);
        const usable = await findUsableTryPack(tx, apiId);
        if (usable) return { kind: "ready", pack: usable };

        const unsettled = await findUnsettledTryPurchase(tx, apiId);
        if (unsettled) {
          const timedFetch = (u: string, init?: RequestInit) => buyer.fetch(u, { ...init, signal: AbortSignal.timeout(RECOVER_TIMEOUT_MS) });
          const r = await recoverPack(timedFetch, d.config.publicBaseUrl, apiId, unsettled);
          if (r.kind === "recovered") {
            // A DB error here rolls back and leaves the row unsettled: the next try re-keys it again.
            await markTryActive(tx, unsettled.id, "unsettled", { token: r.token, txHash: null, credits: r.credits });
            const pack = await findUsableTryPack(tx, apiId);
            return { kind: "recovered", credits: r.credits, txHash: pack?.txHash ?? null };
          }
          if (r.kind === "failed") {
            return { kind: "refuse", refusal: { status: 503, error: "recovery_pending", message: "An earlier payment is still settling. Try again in a minute." } };
          }
          // 404: never received, nothing paid. 403: final. Either way that attempt is over.
          await markTryEnded(tx, unsettled.id, "unsettled", r.kind === "not_received" ? "void" : "failed", `recovery: ${r.kind}`);
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
        const slot = await reserveTryPurchase(tx, { id, apiId, packId: pack.packId, priceMicros: pack.price, limits: TRY_LIMITS });
        if (!slot.ok) {
          const message = slot.reason === "api_cooldown"
            ? `This API had a live purchase in the last 10 minutes. Try again in ${minutes(slot.retryAfterSeconds)}.`
            : slot.reason === "global_hourly"
              ? `The live demo made ${TRY_LIMITS.globalPerHour} purchases this hour. Try again in ${minutes(slot.retryAfterSeconds)}.`
              : `The live demo made ${TRY_LIMITS.globalPerDay} purchases today. Try again in ${minutes(slot.retryAfterSeconds)}.`;
          return {
            kind: "refuse",
            refusal: { status: 429, error: slot.reason, message, extra: { retryAfterSeconds: slot.retryAfterSeconds }, retryAfter: slot.retryAfterSeconds },
          };
        }
        return { kind: "reserved", id, pack, ruleHash: offer.ruleHash };
      });

      if (plan.kind === "ready") {
        const send = stream(res);
        send({ phase: "ready", txHash: plan.pack.txHash, credits: plan.pack.remaining, pending: plan.pack.pending, boughtAt: plan.pack.boughtAt.toISOString() });
        res.end();
        return;
      }
      if (plan.kind === "recovered") {
        const send = stream(res);
        send({ phase: "settled", txHash: plan.txHash, credits: plan.credits, ms: 0, recovered: true });
        res.end();
        return;
      }
      if (plan.kind === "refuse") {
        if (plan.refusal.retryAfter !== undefined) res.set("retry-after", String(plan.refusal.retryAfter));
        refuse(res, plan.refusal.status, plan.refusal.error, plan.refusal.message, plan.refusal.extra);
        return;
      }
      await pay(d, res, buyer, apiId, plan.id, plan.pack, plan.ruleHash);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      next(e);
    }
  };
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
  send({ phase: "paying", packId: pack.packId, calls: pack.calls, priceMicros: pack.price, wallet: buyer.address, escrow: escrowPacks(d) });
  const onSigned = async (s: { paymentSignature: string; recoverySecret: string }) => {
    saved = s;
    send({ phase: "settling" });
    try {
      await saveTrySignature(d.sql, id, s);
    } catch (e) {
      console.error(`[demo-buy] ${apiId}: saving the signed payment failed: ${(e as Error).message}`);
    }
  };
  let purchase: { token: string; credits: number; txHash: string | null };
  try {
    purchase = escrowPacks(d)
      ? await buyEscrow(d, buyer, apiId, id, pack, ruleHash, onSigned)
      : await buyer.buyPack(pack.buyUrl, { amount: BigInt(pack.price) }, { onSigned });
  } catch (e) {
    const detail = (e as Error)?.message ?? String(e);
    const keep = e instanceof PaymentNotSentError ? null : e instanceof PackPurchaseError && e.paymentSignature && e.recoverySecret
      ? { paymentSignature: e.paymentSignature, recoverySecret: e.recoverySecret }
      : saved;
    if (keep) {
      await markTryUnsettled(d.sql, id, { ...keep, error: detail });
      send({ phase: "failed", spent: true, message: "The payment was sent but not confirmed yet. It is saved, and the next try picks it up without paying twice." });
    } else {
      await markTryEnded(d.sql, id, "buying", "void", detail);
      send({ phase: "failed", spent: false, message: "The payment did not go through. Nothing was paid." });
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
    send({ phase: "failed", spent: true, message: "The payment went through but saving the pack failed. It is kept, and the next try picks it up without paying twice." });
  }
  res.end();
}

const escrowPacks = (d: AppDeps) => d.config.packMode === "escrow";

/**
 * An escrow pack, bought the way the buyer agent buys one: a fresh IOU key, the 402's datum checked (our key,
 * our refund address, the chosen pack's calls, price and promise) before anything is signed, and the channel
 * and key saved on the row before the lock is sent, so a lock that lands can always be signed for and closed.
 */
async function buyEscrow(
  d: AppDeps, buyer: DemoBuyer, apiId: string, id: string, pack: PackOffer, ruleHash: string,
  onSigned: (s: { paymentSignature: string; recoverySecret: string }) => Promise<void>,
): Promise<{ token: string; credits: number; txHash: string | null }> {
  const key = newReceiptKey();
  const keys = { receiptKey: key.publicKey, refundAddress: buyer.address };
  let checked: { channelId: string; ruleHash: string } | null = null;
  const p = await buyer.buyEscrowPack(pack.buyUrl, keys, (req) => {
    const datum = checkEscrowOffer(req, { ...keys, maxPackMicros: MAX_PACK_MICROS }, {
      calls: pack.calls, priceMicros: BigInt(pack.price), ruleHash,
    });
    checked = { channelId: datum.channelId, ruleHash: `sha256:${datum.ruleHash}` };
  }, {
    onSigned: async (s) => {
      if (checked) {
        await saveTryChannel(d.sql, id, { ...checked, iouSecret: key.secretKey }).catch((e: unknown) =>
          console.error(`[demo-buy] ${apiId}: saving the escrow channel failed: ${(e as Error).message}`));
      }
      await onSigned(s);
    },
  });
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
