import { formatTusdm } from "./money";

/**
 * The gateway's 402 answer to an unpaid call: the packs an agent can buy, read from its own fields.
 * Shape (apps/gateway): { error: "credits_required", packs: [{ packId, calls, price, asset, buyUrl }], ruleHash, ruleUrl }.
 * `price` is in micro-units of the asset (6 decimals).
 */
export type OfferPack = { packId: string; calls: number; priceMicros: string; asset: string; assetName: string; buyUrl: string | null };
export type Offer = { packs: OfferPack[]; ruleUrl: string | null };

const CIP67_FUNGIBLE = "0014df10";

/** The readable token name inside a Cardano asset id (policy id + hex asset name, CIP-67 label stripped). */
export function assetName(asset: string): string {
  const hex = (asset.includes(".") ? asset.split(".")[1] : asset.slice(56)).toLowerCase();
  const name = hex.startsWith(CIP67_FUNGIBLE) ? hex.slice(CIP67_FUNGIBLE.length) : hex;
  if (!name || name.length % 2 !== 0 || !/^[0-9a-f]+$/.test(name)) return "tokens";
  const text = String.fromCharCode(...(name.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  return /^[\x20-\x7e]+$/.test(text) ? text : "tokens";
}

export function parseOffer(body: unknown): Offer | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { packs?: unknown; ruleUrl?: unknown };
  if (!Array.isArray(b.packs)) return null;
  const packs = b.packs.flatMap((p): OfferPack[] => {
    const x = p as Record<string, unknown>;
    const price = typeof x.price === "string" || typeof x.price === "number" ? String(x.price) : "";
    if (typeof x.packId !== "string" || typeof x.calls !== "number" || !/^\d+$/.test(price) || typeof x.asset !== "string") return [];
    return [{
      packId: x.packId,
      calls: x.calls,
      priceMicros: price,
      asset: x.asset,
      assetName: assetName(x.asset),
      buyUrl: typeof x.buyUrl === "string" ? x.buyUrl : null,
    }];
  });
  if (packs.length === 0) return null;
  return { packs, ruleUrl: typeof b.ruleUrl === "string" ? b.ruleUrl : null };
}

/** "2 tUSDM · 100 calls" */
export function offerHeadline(p: OfferPack): string {
  return `${formatTusdm(p.priceMicros)} ${p.assetName} · ${p.calls} calls`;
}
