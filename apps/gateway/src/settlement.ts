// PACK_MODE=hybrid: which settlement a pack purchase gets (direct or escrow), and why.
import { UPTIME_WINDOW_DAYS, chooseSettlement, sha256Hex, uptimeFraction, type SettlementMode } from "@hirakumi/core";
import { getOrCreateSettlementDecision, loadSettlementSignals, type PackRow, type SettlementSignals, type Sql } from "@hirakumi/db";
import type { AppDeps } from "./deps";
import { QUOTE_TTL_SECONDS, type BuyerKeys } from "./escrowPacks";
import type { LoadedApi } from "./registry";

/**
 * What the 402 carries in `extra.settlement`. `recommended` is set only when the policy chose escrow but this
 * gateway can't escrow the pack (no escrow settings, no chain access, or a price that doesn't split per call).
 */
export type PackSettlement = { mode: SettlementMode; reasons: string[]; recommended?: SettlementMode };

const DAY_MS = 86_400_000;
export const SIGNALS_TTL_MS = 60_000;

/** One query per API per minute: listing age and health_events. Keyed by the database, so each app has its own. */
const signalCache = new WeakMap<Sql, Map<string, { at: number; value: Promise<SettlementSignals | null> }>>();

function signals(sql: Sql, apiId: string): Promise<SettlementSignals | null> {
  let cache = signalCache.get(sql);
  if (!cache) signalCache.set(sql, (cache = new Map()));
  const hit = cache.get(apiId);
  if (hit && Date.now() - hit.at < SIGNALS_TTL_MS) return hit.value;
  const value = loadSettlementSignals(sql, apiId, UPTIME_WINDOW_DAYS);
  cache.set(apiId, { at: Date.now(), value });
  value.catch(() => cache.delete(apiId));
  return value;
}

/** Tests and /internal/apis/:apiId/reload: the next decision reads health_events again. */
export function forgetSettlementSignals(sql: Sql, apiId?: string): void {
  if (apiId === undefined) signalCache.delete(sql);
  else signalCache.get(sql)?.delete(apiId);
}

/** Escrow needs the escrow settings, chain access to verify the lock, and a price that splits evenly per call. */
export function canEscrow(d: AppDeps, pack: PackRow): boolean {
  return d.config.packEscrow !== null && !!d.escrowChain && BigInt(pack.price_micros) % BigInt(pack.calls) === 0n;
}

export const decisionKey = (apiId: string, packId: string, b: BuyerKeys, priceMicros: string) =>
  sha256Hex(`${apiId}|${packId}|${b.receiptKey}|${b.refundAddress}|${priceMicros}`);

/** The policy's answer for a buyer who can escrow, from live data. Persist it before offering it (see below). */
export async function policyFor(d: AppDeps, loaded: LoadedApi, pack: PackRow, buyerCanEscrow: boolean) {
  if (!buyerCanEscrow) return chooseSettlement({ priceMicros: 0n, sellerUptime7d: 1, listingAgeDays: 0, buyerCanEscrow }, d.config.settlement);
  const s = await signals(d.sql, loaded.api.id);
  if (!s) throw new Error(`no listing for ${loaded.api.id}`);
  return chooseSettlement({
    priceMicros: BigInt(pack.price_micros),
    sellerUptime7d: uptimeFraction({ from: s.windowStart, to: s.now, startHealth: s.startHealth, events: s.events }),
    listingAgeDays: (s.now.getTime() - s.listedAt.getTime()) / DAY_MS,
    buyerCanEscrow,
  }, d.config.settlement);
}

/**
 * The settlement for this purchase. x402 matches the paid retry's `extra` against a fresh 402 by deep equality,
 * and uptime and listing age move, so the answer must not be recomputed from live data between the two:
 * - no buyer keys: always direct with one fixed reason (no time-varying input is read);
 * - buyer keys: the first answer is stored in settlement_decisions for QUOTE_TTL_SECONDS under
 *   (api, pack, receipt key, refund address, price) and every 402 and paid retry for that key reads it back.
 */
export async function settlementFor(d: AppDeps, loaded: LoadedApi, pack: PackRow, keys: BuyerKeys | null): Promise<PackSettlement> {
  const decided = keys === null
    ? await policyFor(d, loaded, pack, false)
    : await getOrCreateSettlementDecision(d.sql, decisionKey(loaded.api.id, pack.id, keys, pack.price_micros), async () => ({
      apiId: loaded.api.id, packId: pack.id, ...(await policyFor(d, loaded, pack, true)), ttlSeconds: QUOTE_TTL_SECONDS,
    }));
  if (decided.mode === "escrow" && !canEscrow(d, pack)) return { mode: "direct", reasons: decided.reasons, recommended: "escrow" };
  return { mode: decided.mode, reasons: decided.reasons };
}
