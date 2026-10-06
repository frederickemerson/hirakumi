import { outputHash } from "@hirakumi/core";
import { errorJson, json, readJson, sameOrigin } from "./http";
import { buildGatewayCall, describeTryResult, type TryReceipt } from "./try";
import type { TryPack } from "./try-repo";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_CHARS = 20_000;
const TIMEOUT_MS = 25_000;

export type TryDeps = {
  gatewayBase: string;
  /** The pack this API's tries pay with (live purchase first, then TRY_CREDIT_TOKENS), or null. */
  pack: (apiId: string) => Promise<TryPack | null>;
  /** false = this visitor called too recently */
  allow: (key: string) => boolean;
  /** Shared limit across instances: a message when the pack can't take another paid try, else null. */
  budget: (apiId: string, token: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function visitorKey(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

function parseBody(text: string): unknown {
  const clipped = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
  try {
    return JSON.parse(text);
  } catch {
    return clipped;
  }
}

export const receiptsPath = (apiId: string) => `/api/try/${encodeURIComponent(apiId)}/receipts`;

/** One paid call through the real gateway, like an agent with a pack: the answer plus its receipt. */
export function createTryHandler(d: TryDeps) {
  const doFetch = d.fetchImpl ?? fetch;
  const now = d.now ?? (() => performance.now());
  return async (req: Request, apiId: string): Promise<Response> => {
    if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
    const b = await readJson(req);
    const opId = typeof b?.opId === "string" ? b.opId : "";
    const method = typeof b?.method === "string" ? b.method.toUpperCase() : "";
    const input = b?.input;
    if (!opId || opId.length > 64 || !METHODS.has(method) || !input || typeof input !== "object" || Array.isArray(input)) {
      return errorJson(400, "Pick an endpoint and fill in its input.");
    }
    const pack = await d.pack(apiId);
    if (!pack) return json({ error: "No pack with credits yet. Buy one live first.", needsPack: true }, 409);
    if (!d.allow(visitorKey(req))) return errorJson(429, "One call every few seconds, please. Wait a moment and try again.");
    const problem = await d.budget(apiId, pack.token);
    if (problem) return errorJson(429, problem);

    const call = buildGatewayCall(d.gatewayBase, apiId, { opId, method }, input as Record<string, unknown>, pack.token);
    const started = now();
    let res: Response;
    try {
      res = await doFetch(call.url, { ...call.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return errorJson(502, "We couldn't reach the Hirakumi gateway. Try again in a minute.");
    }
    const latencyMs = Math.round(now() - started);
    const text = await res.text();
    const body = parseBody(text);
    const remaining = res.headers.get("x-credits-remaining");
    const creditsRemaining = remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null;
    const result = describeTryResult(res.status, body);
    const receipt: TryReceipt = {
      verdict: result.kind === "kept" ? "kept" : result.kind === "not_kept" ? "not_kept" : "no_charge",
      creditsLeft: creditsRemaining,
      // The gateway logs sha256(token id + ";" + body) for the answer it sent; this is the same hash over what we got.
      outputHash: res.status === 200 ? outputHash(pack.creditTokenId, text) : null,
      receiptsUrl: receiptsPath(apiId),
    };
    return json({ status: res.status, latencyMs, creditsRemaining, result, receipt, body, request: { method, url: call.url } });
  };
}

/** The pack's receipts from the gateway's /receipts, fetched with the server-side token. */
export function createReceiptsHandler(d: { gatewayBase: string; pack: (apiId: string) => Promise<TryPack | null>; fetchImpl?: typeof fetch }) {
  const doFetch = d.fetchImpl ?? fetch;
  return async (apiId: string): Promise<Response> => {
    const pack = await d.pack(apiId);
    if (!pack) return errorJson(404, "No pack has been bought for this API yet.");
    let res: Response;
    try {
      res = await doFetch(`${d.gatewayBase.replace(/\/+$/, "")}/a/${encodeURIComponent(apiId)}/receipts`, {
        headers: { authorization: `Bearer ${pack.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return errorJson(502, "We couldn't reach the Hirakumi gateway. Try again in a minute.");
    }
    if (!res.ok) return errorJson(502, `The gateway answered HTTP ${res.status} for the receipts.`);
    return json(await res.json(), 200, { "cache-control": "no-store" });
  };
}
