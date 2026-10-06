import { USDM_PREPROD_ASSET } from "@x402/cardano";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type PackOffer = { packId: string; calls: number; price: string; asset: string; buyUrl: string };
export type CreditsRequired = { error: "credits_required"; packs: PackOffer[]; ruleHash: string; ruleUrl: string };
export type CallOutcome =
  | { kind: "ok"; body: unknown; remaining: number | null; latencyMs: number }
  | { kind: "promise_not_met"; reasons: string[]; remaining: number | null; latencyMs: number }
  | { kind: "upstream_error"; status: number; reasons: string[]; remaining: number | null; latencyMs: number }
  | { kind: "credits_required"; offer: CreditsRequired }
  | { kind: "down"; message: string }
  | { kind: "bad_input"; message: string }
  | { kind: "token_pending" }
  | { kind: "invalid_token"; message: string }
  | { kind: "unexpected"; status: number; text: string };

export class GatewayProtocolError extends Error {}
export class NoAffordablePackError extends Error {}

export function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function messageOf(json: unknown, text: string): string {
  const j = json as { message?: unknown; error?: unknown } | undefined;
  if (typeof j?.message === "string") return j.message;
  if (typeof j?.error === "string") return j.error;
  return text.slice(0, 300);
}

function reasonsOf(json: unknown): string[] {
  const r = (json as { reasons?: unknown } | undefined)?.reasons;
  return Array.isArray(r) ? r.map(String) : [];
}

function readRemaining(res: Response): number | null {
  const h = res.headers.get("x-credits-remaining");
  if (h === null || !/^\d+$/.test(h)) return null;
  return Number(h);
}

export function parseCreditsRequired(body: unknown, gatewayUrl: string): CreditsRequired {
  const b = body as Partial<CreditsRequired> | undefined;
  if (!b || b.error !== "credits_required" || !Array.isArray(b.packs) || typeof b.ruleHash !== "string" || typeof b.ruleUrl !== "string") {
    throw new GatewayProtocolError(`402 body is not credits_required: ${JSON.stringify(body)}`);
  }
  const packs = b.packs.map((p: Partial<PackOffer>) => {
    if (typeof p?.packId !== "string" || !Number.isInteger(p.calls) || typeof p.price !== "string" || !/^\d+$/.test(p.price) ||
        typeof p.asset !== "string" || typeof p.buyUrl !== "string") {
      throw new GatewayProtocolError(`bad pack offer: ${JSON.stringify(p)}`);
    }
    return { packId: p.packId, calls: p.calls as number, price: p.price, asset: p.asset, buyUrl: new URL(p.buyUrl, gatewayUrl).toString() };
  });
  return { error: "credits_required", packs, ruleHash: b.ruleHash, ruleUrl: new URL(b.ruleUrl, gatewayUrl).toString() };
}

export function choosePack(offer: CreditsRequired, maxPackMicros: bigint): PackOffer {
  const usable = offer.packs.filter((p) => p.asset === USDM_PREPROD_ASSET && p.calls > 0 && BigInt(p.price) <= maxPackMicros);
  if (usable.length === 0) {
    throw new NoAffordablePackError(
      `No payable pack: need asset ${USDM_PREPROD_ASSET} and price ≤ ${maxPackMicros} micros; offered ` +
        offer.packs.map((p) => `${p.packId} ${p.price} ${p.asset}`).join("; "),
    );
  }
  return usable.reduce((best, p) => (BigInt(p.price) * BigInt(best.calls) < BigInt(best.price) * BigInt(p.calls) ? p : best));
}

export function formatMicros(micros: string | bigint): string {
  const v = BigInt(micros);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export async function callOperation(
  fetchImpl: FetchLike,
  a: { gatewayUrl: string; apiId: string; opId: string; query: Record<string, string>; token?: string },
): Promise<CallOutcome> {
  const url = new URL(`/a/${encodeURIComponent(a.apiId)}/x/${encodeURIComponent(a.opId)}`, a.gatewayUrl);
  for (const [k, v] of Object.entries(a.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  if (a.token) headers.authorization = `Bearer ${a.token}`;
  const started = performance.now();
  const res = await fetchImpl(url.toString(), { method: "GET", headers });
  const latencyMs = Math.round(performance.now() - started);
  const text = await res.text();
  const body = safeJson(text);
  const remaining = readRemaining(res);
  switch (res.status) {
    case 200: return { kind: "ok", body: body ?? text, remaining, latencyMs };
    case 422: return { kind: "promise_not_met", reasons: reasonsOf(body), remaining, latencyMs };
    case 502:
    case 504: return { kind: "upstream_error", status: res.status, reasons: reasonsOf(body), remaining, latencyMs };
    case 402: return { kind: "credits_required", offer: parseCreditsRequired(body, a.gatewayUrl) };
    case 503: return { kind: "down", message: messageOf(body, text) };
    case 400: return { kind: "bad_input", message: messageOf(body, text) };
    case 401:
      return (body as { error?: unknown } | undefined)?.error === "token_pending"
        ? { kind: "token_pending" }
        : { kind: "invalid_token", message: messageOf(body, text) };
    default: return { kind: "unexpected", status: res.status, text: text.slice(0, 500) };
  }
}
