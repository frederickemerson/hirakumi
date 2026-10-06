import { Router, type RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { USDM_PREPROD_ASSET, decodeCardanoTransaction } from "@x402/cardano";
import { jcs, newBearerToken, newId, sha256Hex } from "@hirakumi/core";
import { activateTokenByPayment, insertPendingToken, type PackRow } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { downBody, ruleUrl } from "./http";
import { primaryRule, type LoadedApi } from "./registry";

export const PACK_ROUTE = "POST /a/:apiId/packs/:packId";
const PACK_PATH = /^\/a\/([^/]+)\/packs\/([^/]+)$/;
const NETWORK = "cardano:preprod" as const;

export function paymentPayloadHash(payload: unknown): string {
  return sha256Hex(jcs(payload));
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

export function packRouter(d: AppDeps): Router {
  const server = new x402ResourceServer(d.facilitator).register(NETWORK, new ExactCardanoScheme());
  server.onAfterSettle(async (ctx) => {
    if (!ctx.result.success) return;
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
        payTo: async (ctx: HTTPRequestContext) => (await resolvePack(d, ctx.path)).loaded.api.pay_to,
        price: async (ctx: HTTPRequestContext) => {
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
        body: { error: "settlement_failed", reason: result.errorReason, message: "The payment did not settle. No credits were issued." },
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
      const token = newBearerToken();
      const ins = await insertPendingToken(d.sql, {
        id: newId("ct"), apiId: loaded.api.id, packId: pack.id, tokenHash: sha256Hex(token), remaining: pack.calls,
        paymentPayloadHash: paymentPayloadHash(payload.payload), txHash: txHashOf(payload.payload),
      });
      if (!ins.inserted) {
        res.status(409).json({
          error: "payment_already_used", tokenId: ins.id,
          message: "This payment already bought a credit token. Use the token you received the first time.",
        });
        return;
      }
      res.status(200).json({ token, credits: pack.calls, apiId: loaded.api.id, tokenId: ins.id });
    } catch (e) { next(e); }
  };

  const r = Router();
  r.post("/a/:apiId/packs/:packId", guard, paymentMiddleware(routes, server), handler);
  return r;
}
