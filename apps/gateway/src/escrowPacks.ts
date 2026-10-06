// PACK_MODE=escrow: quotes (the datum a 402 offers), and verification of the lock the buyer paid.
import { randomBytes } from "node:crypto";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import { sha256Hex } from "@hirakumi/core";
import {
  getOrCreateQuote, markChannelLocked, markChannelRefused, type ChannelRow, type PackRow, type QuoteRow, type Sql,
} from "@hirakumi/db";
import {
  PACK_ESCROW, checkLockOutput, deriveChannelId, encodePackDatum, parseAddress, validateDatumForLock, type PackDatum,
} from "@hirakumi/escrow";
import type { PackEscrowConfig } from "./config";
import type { EscrowChain } from "./escrowChain";
import type { LoadedApi } from "./registry";

export const PACK_UNIT = USDM_PREPROD_ASSET.replace(".", "");
const [POLICY, ASSET_NAME] = USDM_PREPROD_ASSET.split(".") as [string, string];
export const QUOTE_TTL_SECONDS = 600;

export type BuyerKeys = { receiptKey: string; refundAddress: string };

/** Reads the buyer's IOU key and refund address. A string is an error code for a 400. */
export function buyerKeys(header: (name: string) => string | undefined): BuyerKeys | "receipt_key_required" | "bad_refund_address" {
  const receiptKey = header("x-hirakumi-receipt-key")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(receiptKey)) return "receipt_key_required";
  const refundAddress = header("x-hirakumi-refund-address")?.trim() ?? "";
  try {
    const a = parseAddress("refundAddress", refundAddress);
    if (a.networkId !== 0 || a.payment.kind !== "key") return "bad_refund_address";
  } catch {
    return "bad_refund_address";
  }
  return { receiptKey, refundAddress };
}

export const quoteKey = (apiId: string, packId: string, b: BuyerKeys) =>
  sha256Hex(`${apiId}|${packId}|${b.receiptKey}|${b.refundAddress}`);

export function datumOf(q: Pick<QuoteRow, "channel_id" | "receipt_key" | "refund_address" | "seller_address" | "price_per_call_micros" | "max_calls" | "fee_address" | "fee_bps" | "contest_period_ms" | "close_fee_budget_lovelace">, ruleHash: string, closer: string): PackDatum {
  return {
    channelId: q.channel_id,
    receiptKey: q.receipt_key,
    buyerRefund: q.refund_address,
    seller: q.seller_address,
    policyId: POLICY,
    assetName: ASSET_NAME,
    pricePerCall: BigInt(q.price_per_call_micros),
    maxCalls: BigInt(q.max_calls),
    // Rule hashes are published as "sha256:<hex>"; the datum holds the 32 raw bytes.
    ruleHash: ruleHash.replace(/^sha256:/, ""),
    feeAddress: q.fee_address,
    feeBps: BigInt(q.fee_bps),
    closer,
    contestPeriod: BigInt(q.contest_period_ms),
    closeFeeBudget: BigInt(q.close_fee_budget_lovelace),
    stage: { kind: "open" },
  };
}

/**
 * The quote for this buyer and pack: reused while live, so the 402 and the paid retry carry the same datum
 * (x402 matches `extra` by deep equality). Throws when the pack can't be sold as an escrow pack.
 */
export async function quoteFor(sql: Sql, cfg: PackEscrowConfig, loaded: LoadedApi, pack: PackRow, ruleHash: string, b: BuyerKeys): Promise<QuoteRow> {
  const price = BigInt(pack.price_micros);
  if (price % BigInt(pack.calls) !== 0n) throw new Error(`pack ${pack.id}: price ${price} does not divide by ${pack.calls} calls`);
  return getOrCreateQuote(sql, quoteKey(loaded.api.id, pack.id, b), () => {
    const channelId = deriveChannelId({
      apiId: loaded.api.id, packId: pack.id, receiptKey: b.receiptKey, refundAddress: b.refundAddress,
      quoteNonce: randomBytes(16).toString("hex"),
    });
    const row = {
      quote_key: quoteKey(loaded.api.id, pack.id, b), channel_id: channelId, api_id: loaded.api.id, pack_id: pack.id,
      receipt_key: b.receiptKey, refund_address: b.refundAddress, seller_address: loaded.api.pay_to,
      fee_address: cfg.feeAddress, fee_bps: cfg.feeBps, price_micros: price.toString(),
      price_per_call_micros: (price / BigInt(pack.calls)).toString(), max_calls: pack.calls,
      unsigned_allowance: pack.unsigned_allowance, contest_period_ms: String(cfg.contestPeriodMs),
      close_fee_budget_lovelace: String(cfg.closeFeeBudgetLovelace), ttlSeconds: QUOTE_TTL_SECONDS,
    };
    const datum = datumOf(row, ruleHash, cfg.closerVkh);
    validateDatumForLock(datum, { priceMicros: price });
    return { ...row, datum_cbor: encodePackDatum(datum) };
  });
}

/** The x402 `extra` for an escrow offer: script method, the validator, and the inline datum the lock must carry. */
export function escrowExtra(q: QuoteRow): Record<string, unknown> {
  return {
    assetTransferMethod: "script",
    script: { type: "plutusV3", code: PACK_ESCROW.scriptCbor },
    datum: q.datum_cbor,
    channelId: q.channel_id,
    pricePerCall: q.price_per_call_micros,
    unsignedAllowance: q.unsigned_allowance,
    feeBps: q.fee_bps,
    contestPeriodMs: Number(q.contest_period_ms),
    closeFeeBudgetLovelace: Number(q.close_fee_budget_lovelace),
  };
}

export type LockVerdict = "locked" | "refused" | "unseen" | "unchanged";

/**
 * Finds the lock in the payment tx and checks it before the credit token goes live: datum bytes equal the
 * quote's, the output is at the escrow, holds ≥ price of the pack asset, and ONLY lovelace + the pack asset.
 */
export async function verifyChannelLock(sql: Sql, chain: Pick<EscrowChain, "txOutputs">, ch: ChannelRow): Promise<LockVerdict> {
  if (ch.status !== "pending") return "unchanged";
  const outs = await chain.txOutputs(ch.lock_tx_hash);
  if (!outs) return "unseen";
  const check = checkLockOutput(outs, { datumCbor: ch.datum_cbor, unit: PACK_UNIT, priceMicros: BigInt(ch.price_micros) });
  if (!check.ok) {
    console.warn(`[escrow] channel ${ch.channel_id} lock ${ch.lock_tx_hash} refused: ${check.reason}`);
    await markChannelRefused(sql, ch.channel_id, check.reason);
    return "refused";
  }
  await markChannelLocked(sql, ch.channel_id, check.output.index);
  return "locked";
}
