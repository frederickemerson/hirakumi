import { Router, type RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { USDM_PREPROD_ASSET, decodeCardanoTransaction } from "@x402/cardano";
import { jcs, newBearerToken, newId, sha256Hex } from "@hirakumi/core";
import { timingSafeEqual } from "node:crypto";
import {
  activateTokenByPayment, findTokenByTx, getChannelByLockTx, insertPendingToken, openChannelFromQuote, rotateTokenById, type PackRow,
} from "@hirakumi/db";
import { PACK_ESCROW } from "@hirakumi/escrow";
import { buyerKeys, escrowExtra, quoteFor, quoteKey, verifyChannelLock, type BuyerKeys } from "./escrowPacks";
import type { AppDeps } from "./deps";
import { downBody, ruleUrl } from "./http";
import { primaryRule, type LoadedApi } from "./registry";

export const PACK_ROUTE = "POST /a/:apiId/packs/:packId";
const PACK_PATH = /^\/a\/([^/]+)\/packs\/([^/]+)$/;
const NETWORK = "cardano:preprod" as const;

export function paymentPayloadHash(payload: unknown): string {
  return sha256Hex(jcs(payload));
}

const RECOVERY_HASH = /^[0-9a-f]{64}$/;

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function txHashOf(payload: Record<string, unknown>): string | null {
  try {
    return decodeCardanoTransaction(String(payload.transaction)).txHash;
  } catch {
    return null;
  }
}

async function resolvePack(d: AppDeps, path: string): Promise<{ loaded: LoadedApi; pack: PackRow }> {
  const m = PACK_PATH.exec(path);
  if (!m) throw new Error(`not a pack route: ${path}`);
  const loaded = await d.registry.get(m[1]);
  const pack = loaded?.packs.find((p) => p.id === m[2]);
  if (!loaded || !pack) throw new Error(`unknown pack ${m[2]} for ${m[1]}`);
  if (!loaded.api.pay_to.startsWith("addr_test1")) throw new Error(`seller address for ${m[1]} is not a preprod address`);
  return { loaded, pack };
}

function packExtra(d: AppDeps, loaded: LoadedApi, pack: PackRow): Record<string, unknown> {
  const rule = primaryRule(loaded);
  if (!rule) throw new Error(`no published promise for ${loaded.api.id}`);
  return { apiId: loaded.api.id, packId: pack.id, calls: pack.calls, ruleHash: rule.hash, ruleUrl: ruleUrl(d.config, rule.hash) };
}

const escrowMode = (d: AppDeps) => d.config.packMode === "escrow" && d.config.packEscrow !== null;

function adapterKeys(ctx: HTTPRequestContext): BuyerKeys {
  const keys = buyerKeys((n) => ctx.adapter.getHeader(n));
  if (typeof keys === "string") throw new Error(keys); // the guard answers 400 before x402 runs
  return keys;
}

async function escrowQuote(d: AppDeps, ctx: HTTPRequestContext) {
  const { loaded, pack } = await resolvePack(d, ctx.path);
  const rule = primaryRule(loaded);
  if (!rule) throw new Error(`no published promise for ${loaded.api.id}`);
  return { loaded, pack, quote: await quoteFor(d.sql, d.config.packEscrow!, loaded, pack, rule.hash, adapterKeys(ctx)) };
}

export function packRouter(d: AppDeps): Router {
  const server = new x402ResourceServer(d.facilitator).register(NETWORK, new ExactCardanoScheme());
  server.onAfterSettle(async (ctx) => {
    if (!ctx.result.success) return;
    // Escrow packs go live only once the lock itself is verified on-chain (never on the facilitator's word).
    const channel = ctx.result.transaction ? await getChannelByLockTx(d.sql, ctx.result.transaction) : null;
    if (channel) {
      const verdict = d.escrowChain ? await verifyChannelLock(d.sql, d.escrowChain, channel).catch((e) => {
        console.warn(`[packs] lock check for ${channel.channel_id} failed, the watcher retries: ${(e as Error).message}`);
        return "unseen";
      }) : "unseen";
      console.log(`[packs] settled escrow lock tx=${ctx.result.transaction} channel=${channel.channel_id} ${verdict}`);
      return;
    }
    const activated = await activateTokenByPayment(
      d.sql, paymentPayloadHash(ctx.paymentPayload.payload), ctx.result.transaction || null, ctx.result.payer ?? null,
    );
    console.log(`[packs] settled tx=${ctx.result.transaction} token activated=${activated}`);
  });
  server.onSettleFailure(async (ctx) => {
    console.warn(`[packs] settlement failed, credit token stays pending: ${ctx.error.message}`);
  });

  const routes: RoutesConfig = {
    [PACK_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: async (ctx: HTTPRequestContext) => escrowMode(d) ? PACK_ESCROW.address : (await resolvePack(d, ctx.path)).loaded.api.pay_to,
        price: async (ctx: HTTPRequestContext) => {
          if (escrowMode(d)) {
            const { loaded, pack, quote } = await escrowQuote(d, ctx);
            return { amount: pack.price_micros, asset: USDM_PREPROD_ASSET, extra: { ...packExtra(d, loaded, pack), ...escrowExtra(quote) } };
          }
          const { loaded, pack } = await resolvePack(d, ctx.path);
          return { amount: pack.price_micros, asset: USDM_PREPROD_ASSET, extra: packExtra(d, loaded, pack) };
        },
        maxTimeoutSeconds: 600,
        extra: { confirmationPolicy: { l1Confirmations: d.config.l1Confirmations } },
      },
      description: "A pack of credits for a Hirakumi API. A credit is used only when a response keeps the published promise.",
      mimeType: "application/json",
      unpaidResponseBody: async (ctx: HTTPRequestContext) => {
        const { loaded, pack } = await resolvePack(d, ctx.path);
        if (escrowMode(d)) {
          const { quote } = await escrowQuote(d, ctx);
          const { script: _script, ...offer } = escrowExtra(quote);
          return {
            contentType: "application/json",
            body: {
              error: "payment_required", mode: "escrow", ...packExtra(d, loaded, pack), price: pack.price_micros, asset: USDM_PREPROD_ASSET,
              escrowAddress: PACK_ESCROW.address, ...offer,
              message: `Pay once to lock ${pack.calls} calls in escrow. The seller is paid only for calls you sign IOUs for; the rest comes back to you on Settle.`,
            },
          };
        }
        return {
          contentType: "application/json",
          body: {
            error: "payment_required", ...packExtra(d, loaded, pack), price: pack.price_micros, asset: USDM_PREPROD_ASSET,
            message: `Pay once to get ${pack.calls} credits. A credit is used only when a response keeps the promise.`,
          },
        };
      },
      settlementFailedResponseBody: (_ctx, result) => ({
        contentType: "application/json",
        body: { error: "settlement_failed", reason: result.errorReason, message:
          "The payment did not confirm in time, but it may still land on-chain. Do not pay again: POST the same " +
          "PAYMENT-SIGNATURE and your X-Hirakumi-Recovery-Secret to this URL + /recover to get your credit token (it works once the payment settles)." },
      }),
    },
  };

  /** Runs before x402: unknown pack → 404, Down → 503, so no payment is ever requested for them. */
  const guard: RequestHandler = async (req, res, next) => {
    try {
      const loaded = await d.registry.get(req.params.apiId);
      if (!loaded || loaded.api.state !== "live") { res.status(404).json({ error: "api_not_found" }); return; }
      const pack = loaded.packs.find((p) => p.id === req.params.packId);
      if (!pack) { res.status(404).json({ error: "pack_not_found" }); return; }
      const snap = d.health.get(loaded.api.id);
      if (snap?.health === "down") { res.status(503).json(downBody(d.config, snap)); return; }
      if (!primaryRule(loaded)) { res.status(503).json({ error: "promise_not_published" }); return; }
      if (escrowMode(d)) {
        const keys = buyerKeys((n) => req.header(n));
        if (keys === "receipt_key_required") {
          res.status(400).json({ error: keys, message: "Escrow packs need X-Hirakumi-Receipt-Key: the 32-byte ed25519 public key (hex) you will sign IOUs with." }); return;
        }
        if (keys === "bad_refund_address") {
          res.status(400).json({ error: keys, message: "Escrow packs need X-Hirakumi-Refund-Address: a preprod address with a key payment credential." }); return;
        }
        if (BigInt(pack.price_micros) % BigInt(pack.calls) !== 0n) { res.status(503).json({ error: "pack_not_escrowable" }); return; }
        res.locals.buyerKeys = keys;
      }
      res.locals.loaded = loaded;
      res.locals.pack = pack;
      next();
    } catch (e) { next(e); }
  };

  /** Only reached after x402 verified the payment. Settlement happens after this returns (status < 400). */
  const handler: RequestHandler = async (req, res, next) => {
    try {
      const loaded = res.locals.loaded as LoadedApi;
      const pack = res.locals.pack as PackRow;
      const header = req.header("payment-signature") ?? req.header("x-payment");
      if (!header) { res.status(402).json({ error: "payment_required" }); return; }
      const payload = decodePaymentSignatureHeader(header);
      // Audit C1: the transaction is the payment. A status >= 400 here cancels settlement.
      const txHash = (d.paymentTxHash ?? txHashOf)(payload.payload);
      if (!txHash) { res.status(400).json({ error: "unreadable_payment", message: "The payment is not a readable Cardano transaction." }); return; }
      const recoveryHash = req.header("x-hirakumi-recovery")?.trim().toLowerCase() ?? null;
      if (recoveryHash !== null && !RECOVERY_HASH.test(recoveryHash)) {
        res.status(400).json({ error: "invalid_recovery_hash", message: "X-Hirakumi-Recovery must be the sha256 hex of your recovery secret." }); return;
      }
      const token = newBearerToken();
      const ins = await insertPendingToken(d.sql, {
        id: newId("ct"), apiId: loaded.api.id, packId: pack.id, tokenHash: sha256Hex(token), remaining: pack.calls,
        paymentPayloadHash: paymentPayloadHash(payload.payload), txHash, recoveryHash,
      });
      if (!ins.inserted) {
        res.status(409).json({
          error: "payment_already_used", tokenId: ins.id,
          message: "This payment already bought a credit token. If you never received it, POST the same PAYMENT-SIGNATURE with X-Hirakumi-Recovery-Secret to this URL + /recover.",
        });
        return;
      }
      if (escrowMode(d)) {
        // The quote this payment answered: x402 already matched its datum byte for byte.
        const keys = res.locals.buyerKeys as BuyerKeys;
        const accepted = payload.accepted?.extra as { channelId?: unknown } | undefined;
        const channelId = typeof accepted?.channelId === "string" ? accepted.channelId : "";
        const opened = await openChannelFromQuote(d.sql, { quoteKey: quoteKey(loaded.api.id, pack.id, keys), channelId, creditTokenId: ins.id, lockTxHash: txHash });
        if (!opened) {
          res.status(409).json({ error: "quote_not_found", message: "This offer expired or was already paid. Ask for a new 402 and pay that." }); return;
        }
        res.status(200).json({
          token, credits: pack.calls, apiId: loaded.api.id, tokenId: ins.id, mode: "escrow", channelId,
          escrowAddress: PACK_ESCROW.address, channelUrl: `${d.config.publicBaseUrl}/a/${loaded.api.id}/channels/${channelId}`,
        });
        return;
      }
      res.status(200).json({ token, credits: pack.calls, apiId: loaded.api.id, tokenId: ins.id });
    } catch (e) { next(e); }
  };

  /**
   * Recovery (review I1): if settlement failed or timed out, the buyer never saw the token, and a plain retry
   * can't help (the UTxO may be spent, or the payment is already used). Presenting the exact signed payload
   * proves the payment, so we re-key its token. No verify or settle runs here; the token works once the
   * payment row is active (settle hook or reconciler).
   */
  const recover: RequestHandler = async (req, res, next) => {
    try {
      const header = req.header("payment-signature") ?? req.header("x-payment");
      if (!header) { res.status(400).json({ error: "payment_signature_required", message: "Send the same PAYMENT-SIGNATURE header you paid with." }); return; }
      let payload: ReturnType<typeof decodePaymentSignatureHeader>;
      try { payload = decodePaymentSignatureHeader(header); } catch { res.status(400).json({ error: "invalid_payment_signature" }); return; }
      const txHash = (d.paymentTxHash ?? txHashOf)(payload.payload);
      const row = txHash ? await findTokenByTx(d.sql, req.params.apiId, txHash) : null;
      if (!row) { res.status(404).json({ error: "payment_not_found", message: "This API never received that payment." }); return; }
      // Audit C2: the payment is public on-chain, so it proves nothing. Only the buyer's secret does.
      const secret = req.header("x-hirakumi-recovery-secret") ?? "";
      if (!row.recoveryHash || !secret || !sameHex(sha256Hex(secret), row.recoveryHash)) {
        res.status(403).json({
          error: "recovery_not_allowed",
          message: "Recovery needs the secret whose sha256 you sent as X-Hirakumi-Recovery when you paid.",
        });
        return;
      }
      const token = newBearerToken();
      const rotated = await rotateTokenById(d.sql, row.id, sha256Hex(token));
      if (!rotated) { res.status(404).json({ error: "payment_not_found" }); return; }
      res.status(200).json({
        token, status: rotated.status, credits: rotated.remaining, apiId: req.params.apiId, tokenId: rotated.id,
        message: rotated.status === "pending"
          ? "Your payment is still being confirmed. This token starts working as soon as it settles."
          : "Here is a fresh token for your pack. Any earlier token for this payment no longer works.",
      });
    } catch (e) { next(e); }
  };

  const r = Router();
  r.post("/a/:apiId/packs/:packId/recover", recover);
  r.post("/a/:apiId/packs/:packId", guard, paymentMiddleware(routes, server), handler);
  return r;
}
