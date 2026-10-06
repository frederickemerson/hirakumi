import { USDM_PREPROD_ASSET } from "@x402/cardano";
import type { FetchLike } from "./gatewayClient.js";

export type WalletBalance = { lovelace: bigint; usdmMicros: bigint };

/** Blockfrost names an asset policyId + hex asset name with no separator; @x402/cardano puts a "." between them. */
const USDM_UNIT = USDM_PREPROD_ASSET.replace(".", "");

/** What the wallet holds on-chain right now, from Blockfrost. An address that was never used holds nothing. */
export async function fetchWalletBalance(
  fetchImpl: FetchLike,
  blockfrost: { baseUrl: string; projectId: string },
  address: string,
): Promise<WalletBalance> {
  const res = await fetchImpl(`${blockfrost.baseUrl.replace(/\/+$/, "")}/addresses/${encodeURIComponent(address)}`, {
    headers: { project_id: blockfrost.projectId, accept: "application/json" },
  });
  if (res.status === 404) return { lovelace: 0n, usdmMicros: 0n };
  if (!res.ok) throw new Error(`Blockfrost answered HTTP ${res.status} for the wallet balance`);
  const body = (await res.json()) as { amount?: { unit?: unknown; quantity?: unknown }[] };
  const qty = (unit: string): bigint => {
    const hit = (body.amount ?? []).find((a) => a.unit === unit);
    return typeof hit?.quantity === "string" && /^\d+$/.test(hit.quantity) ? BigInt(hit.quantity) : 0n;
  };
  return { lovelace: qty("lovelace"), usdmMicros: qty(USDM_UNIT) };
}
