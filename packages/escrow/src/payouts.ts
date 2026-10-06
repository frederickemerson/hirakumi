// The exact arithmetic of `split` and the Settle obligations in
// contracts/pack-escrow/lib/hirakumi/escrow.ak. Clamps, never throws on odd datums.
import type { PackDatum } from "./datum.js";

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

export type Payouts = { sellerGross: bigint; seller: bigint; fee: bigint; buyer: bigint };

/**
 * sellerGross = clamp(accepted × pricePerCall, 0, lockedTokens)
 * fee         = floor(sellerGross × clamp(feeBps, 0, 1000) / 10 000)
 * seller      = sellerGross − fee;  buyer = lockedTokens − sellerGross
 */
export function closePayouts(
  d: Pick<PackDatum, "pricePerCall" | "feeBps">,
  lockedTokens: bigint,
  accepted: number | bigint,
): Payouts {
  const gross = clamp(BigInt(accepted) * d.pricePerCall, 0n, lockedTokens);
  // Both operands are >= 0 here, so bigint truncation equals Aiken's floor division.
  const fee = (gross * clamp(d.feeBps, 0n, 1000n)) / 10_000n;
  return { sellerGross: gross, seller: gross - fee, fee, buyer: lockedTokens - gross };
}

/**
 * `other`: assets besides lovelace and the pack token, keyed by unit
 * (policy id hex ‖ asset name hex). Present only on the buyer's entry, and only
 * when the lock holds such assets.
 */
export type Obligation = { address: string; tokens: bigint; lovelace: bigint; other?: Record<string, bigint> };

export type SettleOptions = {
  /**
   * Whether the buyer pays `txFee`. The validator charges the buyer the fee only
   * when the Settle tx is signed by `closer` or the buyer's payment key; any other
   * settler pays the fee itself and the buyer gets all the locked lovelace.
   * Default true (a closer- or buyer-signed Settle).
   */
  chargeFee?: boolean;
  /** Foreign assets in the lock (not lovelace, not the pack token), by unit. They all go to the buyer. */
  other?: Record<string, bigint>;
};

/**
 * What a Settle transaction must pay, merged per address in first-appearance
 * order (seller, fee, buyer) and without zero entries. For each entry the SUM of
 * outputs to that address with inline datum = channelId bytes must cover the
 * tokens, the lovelace and every `other` asset. Addresses compare as bech32
 * strings, which is exact for the same network.
 *
 * Buyer lovelace = locked − txFee when the fee is charged (closer- or
 * buyer-signed Settle, the default), else all the locked lovelace.
 */
export function settleObligations(
  d: PackDatum,
  locked: { tokens: bigint; lovelace: bigint },
  txFee: bigint,
  opts: SettleOptions = {},
): Obligation[] {
  if (d.stage.kind !== "closing") throw new Error("Settle needs a Closing datum");
  const p = closePayouts(d, locked.tokens, d.stage.accepted);
  const charge = opts.chargeFee ?? true;
  const other = Object.fromEntries(Object.entries(opts.other ?? {}).filter(([, q]) => q > 0n));
  const buyer: Obligation = { address: d.buyerRefund, tokens: p.buyer, lovelace: locked.lovelace - (charge ? txFee : 0n) };
  if (Object.keys(other).length > 0) buyer.other = other;
  const all: Obligation[] = [
    { address: d.seller, tokens: p.seller, lovelace: 0n },
    { address: d.feeAddress, tokens: p.fee, lovelace: 0n },
    buyer,
  ];
  const merged: Obligation[] = [];
  for (const o of all) {
    const same = merged.find((m) => m.address === o.address);
    if (same) {
      same.tokens += o.tokens;
      same.lovelace += o.lovelace;
      if (o.other) same.other = { ...o.other };
    } else merged.push({ ...o });
  }
  return merged.filter((o) => o.tokens > 0n || o.lovelace > 0n || o.other !== undefined);
}
