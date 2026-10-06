/** Masumi preprod tUSDM (escrow token): policy 16a55b2a… + asset name 0014df10745553444d. Never the x402 e675b46e… token. */
export const MASUMI_ESCROW_UNIT =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
export const PAYMENT_SOURCE_TYPE = "Web3CardanoV2";
/** Every Hirakumi agent advertises exactly one Cardano source, so the index is always 0. */
export const SUPPORTED_PAYMENT_SOURCE_INDEX = 0;
/** Node rule: submitResultTime ≥ now + 15 min (payments/index.ts, purchases/shared.ts). We keep 1 min of margin. */
export const MIN_SUBMIT_LEAD_MS = 16 * 60_000;
/** Node rule: payByTime ≤ submitResultTime − 5 min. */
export const MIN_PAYBY_GAP_MS = 5 * 60_000;
/** Node rule: unlockTime ≥ submitResultTime + 15 min (default would be +6 h). */
export const UNLOCK_AFTER_SUBMIT_MS = 16 * 60_000;
/** Node rule: externalDisputeUnlockTime ≥ unlockTime + 15 min. */
export const DISPUTE_AFTER_UNLOCK_MS = 16 * 60_000;
export const DEFAULT_REGISTRY_URL = "https://registry.masumi.network/api/v1";
