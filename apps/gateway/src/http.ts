import type { ErrorRequestHandler } from "express";
import { USDM_PREPROD_ASSET } from "@x402/cardano";
import type { RuleRow } from "@hirakumi/db";
import { estimatedDowntimeSeconds, type GatewayConfig } from "./config";
import type { HealthSnapshot } from "./health";
import type { LoadedApi } from "./registry";

export function parseBearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(hk_[A-Za-z0-9_-]{43})$/.exec(header?.trim() ?? "");
  return m ? m[1] : null;
}

/**
 * Headers for any answer that carries a seller's body (paid calls, previews, escrow job output): the browser must not
 * guess another type than the one sent (an HTML or SVG answer labelled text/plain), and a page opened from it gets
 * a sandbox with no scripts, forms or loads.
 */
export const SELLER_BODY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
} as const;

export function ruleUrl(cfg: Pick<GatewayConfig, "publicBaseUrl">, hash: string): string {
  return `${cfg.publicBaseUrl}/r/${hash}`;
}

export function creditsRequiredBody(cfg: Pick<GatewayConfig, "publicBaseUrl">, loaded: LoadedApi, ruleRow: RuleRow) {
  return {
    error: "credits_required" as const,
    packs: loaded.packs.map((p) => ({
      packId: p.id, calls: p.calls, price: p.price_micros, asset: USDM_PREPROD_ASSET,
      buyUrl: `${cfg.publicBaseUrl}/a/${loaded.api.id}/packs/${p.id}`,
    })),
    ruleHash: ruleRow.hash,
    ruleUrl: ruleUrl(cfg, ruleRow.hash),
  };
}

export function downBody(cfg: Pick<GatewayConfig, "probeIntervalMs" | "thresholds">, snap: HealthSnapshot | undefined) {
  return {
    error: "api_down" as const,
    message: "This API is Down right now. Nothing was charged and no credit was used.",
    estimated_downtime_seconds: estimatedDowntimeSeconds(cfg),
    since: snap?.failingSince?.toISOString() ?? null,
  };
}

/**
 * While the ownership re-check has paused new sales (apis.ownership_paused_at, monitor.ts recheckOwnership): no new
 * offer, pack or job. Null when selling. Credits already bought keep working.
 */
export function sellingPausedBody(api: { ownership_paused_at: Date | null }) {
  if (!api.ownership_paused_at) return null;
  return {
    error: "selling_paused" as const,
    message: "New sales of this API are paused: Hirakumi could not confirm that the seller still controls it (the X-Hirakumi-Verify header at its base URL is missing). Nothing was charged. Credits you already bought still work.",
    since: api.ownership_paused_at.toISOString(),
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const e = err as { type?: string };
  if (e.type === "entity.parse.failed") { res.status(400).json({ error: "invalid_json" }); return; }
  if (e.type === "entity.too.large") { res.status(413).json({ error: "input_too_large", message: "Inputs are limited to 256 KB." }); return; }
  console.error("[gateway]", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
};
