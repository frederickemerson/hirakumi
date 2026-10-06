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

export type Obligation = { address: string; tokens: bigint; lovelace: bigint };

/**
 * What a Settle transaction must pay, merged per address in first-appearance
 * order (seller, fee, buyer) and without zero entries. For each entry the SUM of
 * outputs to that address with inline datum = channelId bytes must cover both
 * amounts. Addresses compare as bech32 strings, which is exact for the same network.
 */
export function settleObligations(
  d: PackDatum,
  locked: { tokens: bigint; lovelace: bigint },
  txFee: bigint,
): Obligation[] {
  if (d.stage.kind !== "closing") throw new Error("Settle needs a Closing datum");
  const p = closePayouts(d, locked.tokens, d.stage.accepted);
  const all: Obligation[] = [
    { address: d.seller, tokens: p.seller, lovelace: 0n },
    { address: d.feeAddress, tokens: p.fee, lovelace: 0n },
    { address: d.buyerRefund, tokens: p.buyer, lovelace: locked.lovelace - txFee },
  ];
  const merged: Obligation[] = [];
  for (const o of all) {
    const same = merged.find((m) => m.address === o.address);
    if (same) {
      same.tokens += o.tokens;
      same.lovelace += o.lovelace;
    } else merged.push({ ...o });
  }
  return merged.filter((o) => o.tokens > 0n || o.lovelace > 0n);
}
