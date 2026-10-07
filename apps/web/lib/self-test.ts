import type { Sql } from "./db";
import { errorJson, json, readJson, type ApiRouteContext } from "./http";
import { getPack } from "./repo/packs";
import { UPDATING } from "./repo/schema";
import { hasSelfTestSchema } from "./repo/self-test-schema";
import { loadOwnedApi } from "./route-helpers";
import { findSelfTestPack, saveSelfTestPack } from "./self-test-repo";
import {
  paySelfPayment, prepareSelfPayment, resumeSelfPayment, SELF_PAY_PENDING, SelfPayError, selfPayRecoverySecret,
  type BuildPayment, type SelfPayOutcome, type SelfPayTarget, type SignedPayment,
} from "./self-test-wallet";
import { createBuyHandler } from "./try-buy";
import { createReceiptsHandler, createTryHandler } from "./try-handler";
import { reserveTryCall, tryEscrowStore } from "./try-repo";
import type { Api } from "./types";

/**
 * The seller's own "Try it live" (/apis/[apiId]/try): signed in, the API is theirs (CSRF-checked like every
 * seller route) and live. The first test is free (Hirakumi's demo wallet, once per listing, a few per seller,
 * enforced by the gateway and the database); later packs are paid from the seller's own wallet, settled direct
 * to their own payout address. Every pack bought here is a self test (migration 0016), never a sale.
 */

/** Calls per hour on one self-test pack; the pack's own credits are the real limit. */
const CALLS_PER_HOUR = 60;

export const sellerTryPath = (apiId: string) => `/api/apis/${encodeURIComponent(apiId)}/try`;

export type SelfTestDeps = {
  gatewayInternalUrl: string;
  internalToken: string;
  /** The gateway's public URL: calls and purchases go through it exactly as an agent's do. */
  gatewayBase: string;
  build: BuildPayment;
  allowBuy: (key: string) => boolean;
  allowCall: (key: string) => boolean;
  /** Derives each wallet payment's recovery secret (selfPayRecoverySecret); the deployment's SESSION_SECRET. */
  recoveryKey: string;
  fetchImpl?: typeof fetch;
};

type Owned = { sellerId: string; api: Api; sql: Sql };

async function ownedLive(req: Request, ctx: ApiRouteContext): Promise<Owned | Response> {
  const o = await loadOwnedApi(req, ctx);
  if (o instanceof Response) return o;
  if (o.api.state !== "live") return errorJson(409, "Try it live opens once your API is live.");
  if (!(await hasSelfTestSchema(o.sql))) return errorJson(503, UPDATING);
  return { sellerId: o.session.sellerId, api: o.api, sql: o.sql };
}

const HEX = /^[0-9a-f]+$/i;
const hex = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && v.length % 2 === 0 && HEX.test(v);

async function target(o: Owned, gatewayBase: string): Promise<SelfPayTarget | Response> {
  const pack = await getPack(o.sql, o.api.id);
  if (!pack) return errorJson(409, "This API has no pack to buy yet.");
  const [seller] = await o.sql<{ cardanoAddr: string }[]>`select cardano_addr from sellers where id = ${o.sellerId}`;
  return { gatewayBase, apiId: o.api.id, packId: pack.id, payTo: seller.cardanoAddr };
}

const payError = (e: unknown): Response => {
  if (e instanceof SelfPayError) return errorJson(e.status, e.message);
  throw e;
};

export function createSelfTestHandlers(d: SelfTestDeps) {
  async function payStep(
    req: Request, ctx: ApiRouteContext,
    step: (d: { fetchImpl?: typeof fetch }, t: SelfPayTarget, signed: SignedPayment, recoverySecret: string) => Promise<SelfPayOutcome>,
  ): Promise<Response> {
    const o = await ownedLive(req, ctx);
    if (o instanceof Response) return o;
    const b = await readJson(req);
    const priceMicros = b?.priceMicros;
    if (!hex(b?.tx, 40_000) || !hex(b?.witnessSet, 20_000) || typeof b?.nonce !== "string" || !/^[0-9a-f]{64}#\d{1,5}$/i.test(b.nonce)
      || typeof priceMicros !== "string" || !/^\d{1,15}$/.test(priceMicros)) {
      return errorJson(400, "The signed payment is incomplete. Start again.");
    }
    const t = await target(o, d.gatewayBase);
    if (t instanceof Response) return t;
    const signed = { tx: b.tx as string, witnessSet: b.witnessSet as string, nonce: b.nonce, priceMicros };
    try {
      const r = await step({ fetchImpl: d.fetchImpl }, t, signed, selfPayRecoverySecret(d.recoveryKey, t, signed.nonce));
      if (r.kind === "pending") return json({ status: "pending", message: SELF_PAY_PENDING }, 202);
      await saveSelfTestPack(o.sql, { apiId: o.api.id, sellerId: o.sellerId, token: r.token, txHash: r.txHash, credits: r.credits });
      return json({ credits: r.credits, txHash: r.txHash, pending: r.pending });
    } catch (e) {
      return payError(e);
    }
  }

  return {
    /** POST .../try/free: the free test, streamed from the gateway like the showcase's "Buy a pack live". */
    async free(req: Request, ctx: ApiRouteContext): Promise<Response> {
      const o = await ownedLive(req, ctx);
      if (o instanceof Response) return o;
      return createBuyHandler({
        gatewayInternalUrl: d.gatewayInternalUrl, internalToken: d.internalToken, allow: d.allowBuy, fetchImpl: d.fetchImpl,
        gatewayPath: (apiId) => `/internal/demo/self-test/${encodeURIComponent(apiId)}`,
      })(req, o.api.id);
    },

    /** POST .../try: one paid call with this seller's self-test pack. */
    async call(req: Request, ctx: ApiRouteContext): Promise<Response> {
      const o = await ownedLive(req, ctx);
      if (o instanceof Response) return o;
      return createTryHandler({
        gatewayBase: d.gatewayBase,
        pack: (apiId) => findSelfTestPack(o.sql, apiId, o.sellerId),
        allow: d.allowCall,
        budget: (_apiId, token) => reserveTryCall(o.sql, token, CALLS_PER_HOUR),
        escrow: tryEscrowStore(o.sql),
        receiptsUrl: (apiId) => `${sellerTryPath(apiId)}/receipts`,
        fetchImpl: d.fetchImpl,
      })(req, o.api.id);
    },

    /** GET .../try/receipts: the receipts of this seller's newest self-test pack. */
    async receipts(req: Request, ctx: ApiRouteContext): Promise<Response> {
      const o = await ownedLive(req, ctx);
      if (o instanceof Response) return o;
      return createReceiptsHandler({
        gatewayBase: d.gatewayBase, fetchImpl: d.fetchImpl,
        pack: (apiId) => findSelfTestPack(o.sql, apiId, o.sellerId, { withCredits: false }),
      })(o.api.id);
    },

    /**
     * POST .../try/pay/prepare { utxos?, changeAddress }: the price and the unsigned payment for the wallet. No utxos:
     * the wallet can't list them (the email wallet), so the builder reads them at changeAddress.
     */
    async prepare(req: Request, ctx: ApiRouteContext): Promise<Response> {
      const o = await ownedLive(req, ctx);
      if (o instanceof Response) return o;
      const b = await readJson(req);
      const utxos = b?.utxos;
      const usableUtxos = utxos === undefined || (Array.isArray(utxos) && utxos.length > 0 && utxos.length <= 300 && utxos.every((u) => hex(u, 40_000)));
      if (!usableUtxos || !hex(b?.changeAddress, 200)) {
        return errorJson(400, "Connect your wallet again. It sent no usable funds.");
      }
      if (!d.allowBuy(`pay:${o.sellerId}`)) return errorJson(429, "One payment at a time, please. Wait a moment and try again.");
      const t = await target(o, d.gatewayBase);
      if (t instanceof Response) return t;
      try {
        const p = await prepareSelfPayment({ fetchImpl: d.fetchImpl, build: d.build }, t, { utxos: utxos === undefined ? null : (utxos as string[]), changeAddress: b!.changeAddress as string });
        return json({ tx: p.tx, nonce: p.nonce, feeLovelace: p.feeLovelace, priceMicros: p.priceMicros, calls: p.calls });
      } catch (e) {
        return payError(e);
      }
    },

    /**
     * POST .../try/pay { tx, witnessSet, nonce, priceMicros }: pays with the signed transaction; keeps the token.
     * 200 bought (pending: still confirming on-chain), 202 pending (ask .../try/pay/resume), 4xx/5xx a certain failure.
     */
    pay: (req: Request, ctx: ApiRouteContext) => payStep(req, ctx, paySelfPayment),

    /** POST .../try/pay/resume, the same body: where a pending payment stands. Never pays. */
    resume: (req: Request, ctx: ApiRouteContext) => payStep(req, ctx, resumeSelfPayment),
  };
}
