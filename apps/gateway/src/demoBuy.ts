import type { RequestHandler, Response } from "express";
import {
  choosePack, createPackPayer, fetchWalletBalance, formatMicros, NoAffordablePackError, PackPurchaseError, parseCreditsRequired,
  recoverPack, type PackOffer,
} from "@hirakumi/buyer";
import { newId } from "@hirakumi/core";
import {
  findUnsettledTryPurchase, findUsableTryPack, markTryActive, markTryEnded, markTryUnsettled, reserveTryPurchase,
  type TryPurchaseLimits,
} from "@hirakumi/db";
import type { AppDeps, DemoBuyer } from "./deps";
import { creditsRequiredBody } from "./http";
import { primaryRule } from "./registry";

/** Hard limits on live purchases from the demo wallet. Enforced here, in the database, across instances. */
export const TRY_LIMITS: TryPurchaseLimits = { perApiWindowSeconds: 10 * 60, globalPerHour: 6 };
/** Never pay more than this for one pack (5 tUSDM). Also the buyer library's spend cap. */
export const MAX_PACK_MICROS = 5_000_000n;
/** Below this the wallet can't be trusted to cover fees and the min-ADA of the payment output. */
export const MIN_LOVELACE = 3_000_000n;

/**
 * One line of the NDJSON progress stream:
 * paying → settling (the payment is signed and sent) → settled | failed. `ready` = an existing pack is reused.
 */
export type BuyEvent =
  | { phase: "paying"; packId: string; calls: number; priceMicros: string; wallet: string }
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

/**
 * POST /internal/demo/buy-pack/:apiId: a real x402 pack purchase on Cardano preprod from Hirakumi's demo
 * buyer wallet, through the gateway's own public URL, exactly as an outside agent buys. The token is stored
 * in try_tokens for the web's "Try it live". Order: reuse a pack with credits, recover an unsettled payment,
 * price cap, limits, wallet funds, then pay.
 */
export function demoBuyPack(d: AppDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const apiId = req.params.apiId;
      const loaded = await d.registry.get(apiId, { fresh: true });
      if (!loaded || loaded.api.state !== "live") { refuse(res, 404, "api_not_found", "This API is not live."); return; }
      if (d.health.get(loaded.api.id)?.health === "down") {
        refuse(res, 503, "api_down", "This API is Down right now, so nothing is bought."); return;
      }
      if (d.config.packMode !== "direct") {
        refuse(res, 503, "escrow_mode", "Live purchase works with direct packs only."); return;
      }
      const buyer = d.demoBuyer;
      if (!buyer) { refuse(res, 503, "buyer_not_configured", "The demo wallet is not set up on this gateway."); return; }

      const usable = await findUsableTryPack(d.sql, apiId);
      if (usable) {
        const send = stream(res);
        send({ phase: "ready", txHash: usable.txHash, credits: usable.remaining, pending: usable.pending, boughtAt: usable.boughtAt.toISOString() });
        res.end();
        return;
      }

      const unsettled = await findUnsettledTryPurchase(d.sql, apiId);
      if (unsettled) {
        const r = await recoverPack(buyer.fetch, d.config.publicBaseUrl, apiId, unsettled);
        if (r.kind === "recovered") {
          await markTryActive(d.sql, unsettled.id, { token: r.token, txHash: null, credits: r.credits });
          const pack = await findUsableTryPack(d.sql, apiId);
          const send = stream(res);
          send({ phase: "settled", txHash: pack?.txHash ?? null, credits: r.credits, ms: 0, recovered: true });
          res.end();
          return;
        }
        if (r.kind === "failed") {
          refuse(res, 503, "recovery_pending", "An earlier payment is still settling. Try again in a minute."); return;
        }
        // 404: never received, nothing paid. 403: final. Either way that attempt is over.
        await markTryEnded(d.sql, unsettled.id, r.kind === "not_received" ? "void" : "failed", `recovery: ${r.kind}`);
      }

      const rule = primaryRule(loaded);
      if (!rule) { refuse(res, 503, "promise_not_published", "This API has no published promise yet."); return; }
      // The same 402 offer an agent reads, chosen with the buyer library's own rule and cap.
      const offer = parseCreditsRequired(creditsRequiredBody(d.config, loaded, rule), d.config.publicBaseUrl);
      let pack: PackOffer;
      try {
        pack = choosePack(offer, MAX_PACK_MICROS);
      } catch (e) {
        if (e instanceof NoAffordablePackError) {
          refuse(res, 409, "price_over_cap", `A pack for this API costs more than ${formatMicros(MAX_PACK_MICROS)} tUSDM, the live demo's cap.`);
          return;
        }
        throw e;
      }

      const id = newId("try");
      const slot = await reserveTryPurchase(d.sql, { id, apiId, packId: pack.packId, priceMicros: pack.price, limits: TRY_LIMITS });
      if (!slot.ok) {
        const message = slot.reason === "api_cooldown"
          ? `This API had a live purchase in the last 10 minutes. Try again in ${minutes(slot.retryAfterSeconds)}.`
          : `The live demo made ${TRY_LIMITS.globalPerHour} purchases this hour. Try again in ${minutes(slot.retryAfterSeconds)}.`;
        res.set("retry-after", String(slot.retryAfterSeconds));
        refuse(res, 429, slot.reason, message, { retryAfterSeconds: slot.retryAfterSeconds });
        return;
      }

      let funds: { lovelace: bigint; usdmMicros: bigint };
      try {
        funds = await buyer.balance();
      } catch (e) {
        await markTryEnded(d.sql, id, "void", `balance: ${(e as Error).message}`);
        refuse(res, 503, "balance_unavailable", "Couldn't read the demo wallet's balance. Try again in a minute.");
        return;
      }
      if (funds.lovelace < MIN_LOVELACE) {
        await markTryEnded(d.sql, id, "void", "low tADA");
        refuse(res, 409, "low_funds",
          `The demo wallet has ${formatMicros(funds.lovelace)} tADA. It needs at least ${formatMicros(MIN_LOVELACE)} tADA for fees, so nothing was bought.`);
        return;
      }
      if (funds.usdmMicros < BigInt(pack.price)) {
        await markTryEnded(d.sql, id, "void", "low tUSDM");
        refuse(res, 409, "low_funds",
          `The demo wallet has ${formatMicros(funds.usdmMicros)} tUSDM and the pack costs ${formatMicros(pack.price)}, so nothing was bought.`);
        return;
      }

      const send = stream(res);
      const started = Date.now();
      let signed = false;
      send({ phase: "paying", packId: pack.packId, calls: pack.calls, priceMicros: pack.price, wallet: buyer.address });
      try {
        const p = await buyer.buyPack(pack.buyUrl, { amount: BigInt(pack.price) }, {
          onSigned: () => { signed = true; send({ phase: "settling" }); },
        });
        await markTryActive(d.sql, id, { token: p.token, txHash: p.txHash, credits: p.credits });
        send({ phase: "settled", txHash: p.txHash, credits: p.credits, ms: Date.now() - started, recovered: false });
      } catch (e) {
        const detail = (e as Error)?.message ?? String(e);
        if (e instanceof PackPurchaseError && e.paymentSignature && e.recoverySecret) {
          await markTryUnsettled(d.sql, id, { paymentSignature: e.paymentSignature, recoverySecret: e.recoverySecret, error: detail });
          send({ phase: "failed", spent: true, message: "The payment was sent but not confirmed yet. It is saved, and the next try picks it up without paying twice." });
        } else if (!signed) {
          await markTryEnded(d.sql, id, "void", detail);
          send({ phase: "failed", spent: false, message: "The payment did not go through. Nothing was paid." });
        } else {
          await markTryEnded(d.sql, id, "failed", detail);
          send({ phase: "failed", spent: true, message: "The payment was sent but the purchase failed. Check the wallet on Cardanoscan." });
        }
        console.error(`[demo-buy] ${apiId}: ${detail}`);
      }
      res.end();
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      next(e);
    }
  };
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
    balance: () => fetchWalletBalance(doFetch, blockfrost, payer.address),
    fetch: doFetch,
  };
}
